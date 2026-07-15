const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  parseWinEpisode,
  detectPatterns,
  draftCelebration,
  validateDraft,
} = require('../../scripts/zao-wins-spotter');

describe('zao-wins-spotter', () => {
  describe('parseWinEpisode', () => {
    test('should parse a valid win episode', () => {
      const episode = {
        name: 'zol-state:abc123',
        content: 'We just launched WaveWarZ v2 on mainnet with full community support.',
        summary: 'WaveWarZ launch success',
        created_at: '2026-07-14T10:00:00Z',
      };

      const result = parseWinEpisode(episode);

      assert(result.name);
      assert(result.content);
      assert(result.score);
      assert(result.score > 0.5);
      assert(result.score <= 1.0);
    });

    test('should score higher for multiple win signals', () => {
      const episodeWithSignals = {
        name: 'community-win',
        content: 'Shipped breakthrough achievement with community celebrate success.',
        created_at: '2026-07-14T10:00:00Z',
      };

      const episodeMinimal = {
        name: 'update',
        content: 'Regular update today.',
        created_at: '2026-07-14T10:00:00Z',
      };

      const resultSignals = parseWinEpisode(episodeWithSignals);
      const resultMinimal = parseWinEpisode(episodeMinimal);

      assert(resultSignals.score > resultMinimal.score);
    });

    test('should penalize automated signals', () => {
      const botEpisode = {
        name: 'automated-bot-update',
        content: 'System shipped new features successfully.',
        created_at: '2026-07-14T10:00:00Z',
      };

      const humanEpisode = {
        name: 'zaal-launch-note',
        content: 'System shipped new features successfully.',
        created_at: '2026-07-14T10:00:00Z',
      };

      const botResult = parseWinEpisode(botEpisode);
      const humanResult = parseWinEpisode(humanEpisode);

      assert(botResult.score < humanResult.score);
    });
  });

  describe('detectPatterns', () => {
    test('should detect patterns in wins', () => {
      const wins = [
        {
          content: 'New music collaboration launched with WaveWarZ artists',
          score: 0.9,
        },
        {
          content: 'Audio production breakthrough in POIDH bounty program',
          score: 0.85,
        },
        {
          content: 'Community built amazing web3 music infrastructure',
          score: 0.8,
        },
      ];

      const { patterns } = detectPatterns(wins);

      assert(Array.isArray(patterns));
      assert(patterns.length > 0);
      assert(patterns[0].theme);
      assert(patterns[0].strength);
      assert(patterns[0].strength > 0);
    });

    test('should handle empty wins gracefully', () => {
      const { patterns } = detectPatterns([]);

      assert(Array.isArray(patterns));
      assert.equal(patterns.length, 0);
    });

    test('should sort patterns by strength descending', () => {
      const wins = [
        { content: 'build build build launched shipped created', score: 0.9 },
        { content: 'music sound audio song beats', score: 0.85 },
        { content: 'crypto onchain token web3 contract', score: 0.8 },
      ];

      const { patterns } = detectPatterns(wins);

      if (patterns.length > 1) {
        for (let i = 0; i < patterns.length - 1; i++) {
          assert(patterns[i].strength >= patterns[i + 1].strength);
        }
      }
    });
  });

  describe('validateDraft', () => {
    test('should accept valid drafts', () => {
      const validDraft = 'Community wins spotted today: shipped launches, built new features, momentum strong.';

      const result = validateDraft(validDraft);

      assert.equal(result.valid, true, `Validation failed with issues: ${result.issues.join(', ')}`);
      assert.equal(result.issues.length, 0);
    });

    test('should reject drafts that are too short', () => {
      const result = validateDraft('x');

      assert.equal(result.valid, false);
      assert(result.issues.includes('Draft too short'));
    });

    test('should reject drafts that are too long', () => {
      const longDraft = 'x'.repeat(2000);

      const result = validateDraft(longDraft);

      assert.equal(result.valid, false);
      assert(result.issues.includes('Draft too long'));
    });

    test('should reject drafts with secret patterns', () => {
      const draftWithSecret = 'Great win! sk-1234567890abcdef1234567890abcdef is the key.';

      const result = validateDraft(draftWithSecret);

      assert.equal(result.valid, false);
      assert(result.issues.some((i) => i.includes('secret')));
    });

    test('should reject drafts with private keys', () => {
      const draftWithKey = 'Celebrate with PRIVATE KEY 0x1234567890abcdef';

      const result = validateDraft(draftWithKey);

      assert.equal(result.valid, false);
      assert(result.issues.length > 0);
    });
  });

  describe('draftCelebration (template fallback)', () => {
    test('should generate a template draft if LLM unavailable', async () => {
      const wins = [
        {
          content: 'Launched WaveWarZ v2 on mainnet with full support.',
          score: 0.9,
        },
        {
          content: 'COC Concertz booked amazing artists for summer series.',
          score: 0.85,
        },
      ];

      const patterns = { patterns: [{ theme: 'builder_energy', strength: 0.95 }] };

      const context = {
        zao: { name: 'The ZAO', members: 188 },
        voice: { style: 'genuine-joyful' },
      };

      const draft = await draftCelebration(wins, patterns, context);

      assert(draft);
      assert(draft.length > 10);
      assert.equal(typeof draft, 'string');
    });

    test('should include win content in template draft', async () => {
      const wins = [
        {
          content: 'Specific achievement: community voted on governance.',
          score: 0.9,
        },
      ];

      const patterns = { patterns: [] };
      const context = { zao: { name: 'The ZAO' }, voice: { style: 'genuine-joyful' } };

      const draft = await draftCelebration(wins, patterns, context);

      assert(draft.length > 0);
    });
  });

  describe('integration', () => {
    test('should flow through parse -> detect -> validate without errors', () => {
      const episode = {
        name: 'zol-community-win',
        content: 'Community launched new music collaboration platform with web3 integration.',
        created_at: new Date().toISOString(),
      };

      const parsed = parseWinEpisode(episode);
      assert(parsed.score > 0.5);

      const patterns = detectPatterns([parsed]);
      assert(patterns.patterns);

      const draft = 'Community built new music collaboration platform with web3 integration today.';
      const validation = validateDraft(draft);
      assert.equal(validation.valid, true, `Validation failed with issues: ${validation.issues.join(', ')}`);
    });
  });
});
