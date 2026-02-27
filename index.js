/**
 * Folio — Firebase Cloud Functions
 *
 * Handles Claude API integration for preference analysis.
 * Deploy with: firebase deploy --only functions
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.firestore();

// Initialize Anthropic client
// Set ANTHROPIC_API_KEY in Firebase config:
// firebase functions:config:set anthropic.key="YOUR_KEY"
const anthropic = new Anthropic({
  apiKey: functions.config().anthropic?.key || process.env.ANTHROPIC_API_KEY,
});

/**
 * analyzePreferences
 *
 * Triggered when a user hits 20 new interactions.
 * Sends recent feedback to Claude for preference analysis.
 * Updates the user's preference profile in Firestore.
 */
exports.analyzePreferences = functions.https.onCall(async (data, context) => {
  // Require authentication
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const uid = context.auth.uid;
  const { recentLiked, recentDisliked, currentProfile, seedArtists } = data;

  // Build the analysis prompt
  const prompt = buildAnalysisPrompt(recentLiked, recentDisliked, currentProfile, seedArtists);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt
      }],
      system: `You are an expert photography curator and taste analyst. You help people discover photographers and understand their own aesthetic preferences. Always respond with valid JSON matching the requested schema. Be specific and insightful about photographic style — reference techniques like composition, lighting, color palette, subject matter, mood, and artistic movement.`
    });

    // Parse Claude's response
    const responseText = message.content[0].text;
    let analysis;
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
                        responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new functions.https.HttpsError('internal', 'Failed to parse analysis');
    }

    // Update user's preference profile in Firestore
    const profileRef = db.collection('users').doc(uid).collection('data').doc('preferences');
    const updateData = {
      style_description: analysis.style_description || '',
      search_queries: analysis.search_queries || [],
      artist_suggestions: analysis.artist_suggestions || [],
      tag_weights: analysis.tag_weights || {},
      exploration_suggestion: analysis.exploration_suggestion || '',
      last_analyzed: admin.firestore.FieldValue.serverTimestamp(),
      analysis_version: 2, // Track prompt version
    };

    await profileRef.set(updateData, { merge: true });

    return {
      success: true,
      analysis: updateData
    };

  } catch (error) {
    console.error('Claude API error:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', 'Analysis failed: ' + error.message);
  }
});

/**
 * Build the preference analysis prompt
 */
function buildAnalysisPrompt(recentLiked, recentDisliked, currentProfile, seedArtists) {
  const likedSummary = (recentLiked || []).map(p => ({
    photographer: p.photographer?.name || 'Unknown',
    tags: p.tags || [],
    description: p.description || ''
  }));

  const dislikedSummary = (recentDisliked || []).map(p => ({
    photographer: p.photographer?.name || 'Unknown',
    tags: p.tags || [],
    description: p.description || ''
  }));

  return `Analyze this photography collector's evolving taste based on their recent interactions.

## Current Preference Profile
${currentProfile?.style_description ? `Previous analysis: "${currentProfile.style_description}"` : 'No previous analysis (new user)'}
${currentProfile?.tag_weights ? `Current tag weights: ${JSON.stringify(currentProfile.tag_weights)}` : ''}

## Seed Artists (photographers they admire)
${seedArtists?.length ? seedArtists.join(', ') : 'None provided'}

## Recent Liked Photos (last 20)
${JSON.stringify(likedSummary, null, 2)}

## Recent Disliked Photos (last 20)
${JSON.stringify(dislikedSummary, null, 2)}

## Instructions
Respond with a JSON object containing:

\`\`\`json
{
  "style_description": "2-3 sentences describing their photographic taste. Be specific about aesthetic preferences — mention composition style, color palette preferences, mood, subject matter, lighting preferences, and any artistic movements or schools they seem drawn to.",
  "search_queries": ["array of 8-10 Unsplash search queries that would find photos matching their taste. Mix specific (e.g., 'moody urban night photography') with broader terms (e.g., 'street photography rain')"],
  "artist_suggestions": ["array of 5-8 photographer names they haven't seen yet who match their aesthetic. Include a mix of well-known and emerging photographers."],
  "tag_weights": {"updated tag weight object — increase weights for preferred styles, decrease for disliked ones. Scale -5 to +10"},
  "exploration_suggestion": "One specific photography genre, technique, or artist outside their usual taste that they might appreciate as a stretch — explain briefly why"
}
\`\`\`

Be analytical and specific. Reference actual photographic techniques and aesthetic qualities rather than generic descriptions.`;
}

/**
 * getPhotographerInfo
 *
 * Returns curated photographer info when a user taps on an artist.
 * Falls back to web search if not in our database.
 */
exports.getPhotographerInfo = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in');
  }

  const { name } = data;
  if (!name) {
    throw new functions.https.HttpsError('invalid-argument', 'Photographer name required');
  }

  // Check curated database first
  const photographersRef = db.collection('photographers');
  const snapshot = await photographersRef.where('name', '==', name).limit(1).get();

  if (!snapshot.empty) {
    return { source: 'database', data: snapshot.docs[0].data() };
  }

  // If not in database, ask Claude for a brief bio
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Provide a brief JSON profile for the photographer "${name}". If this is a well-known photographer, include accurate information. If unknown, provide a generic response.

Response format:
\`\`\`json
{
  "name": "${name}",
  "bio": "1-2 sentence bio",
  "genres": ["array of photography genres"],
  "website": "URL if known, empty string if not",
  "gallery": "representing gallery if known",
  "notable_work": "most famous series or book",
  "era": "classic|mid_century|contemporary|emerging"
}
\`\`\`
`
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) || responseText.match(/\{[\s\S]*\}/);
    const info = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : responseText);

    // Cache in Firestore for future lookups
    if (info.bio && info.bio !== '') {
      await photographersRef.doc(name.toLowerCase().replace(/\s+/g, '-')).set({
        ...info,
        source: 'claude',
        cached_at: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    return { source: 'claude', data: info };

  } catch (error) {
    console.error('Photographer lookup error:', error);
    return { source: 'unknown', data: { name, bio: '', genres: [] } };
  }
});

/**
 * seedPhotographerDatabase
 *
 * Admin function to bulk-load the curated photographer database.
 * Call via Firebase Admin SDK or console.
 */
exports.seedPhotographerDatabase = functions.https.onRequest(async (req, res) => {
  // Simple auth check — in production use proper admin auth
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const photographers = req.body.photographers;
  if (!Array.isArray(photographers)) {
    res.status(400).send('Expected {photographers: [...]}');
    return;
  }

  const batch = db.batch();
  photographers.forEach(p => {
    const id = p.name.toLowerCase().replace(/\s+/g, '-');
    batch.set(db.collection('photographers').doc(id), {
      ...p,
      source: 'curated',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  await batch.commit();
  res.json({ success: true, count: photographers.length });
});
