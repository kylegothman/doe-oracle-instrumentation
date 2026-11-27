// Stand-in judge and embedding model for --dry-run. It makes no network call.
// Its decisions are arbitrary but repeatable, so the pipeline can be tested without API keys.
const crypto = require('crypto');

function fraction(text, salt) {
  const digest = crypto.createHash('sha256').update(salt + '\n' + text).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

class StandInJudge {
  constructor(options) {
    this.name = (options && options.config && options.config.name) || process.env.STAND_IN_JUDGE || 'stand-in';
  }
  id() {
    return `stand-in:${this.name}`;
  }
  async callApi(prompt) {
    const pass = fraction(String(prompt), this.name) > 0.4;
    return { output: JSON.stringify({ pass, score: pass ? 1 : 0, reason: `Stand-in judge "${this.name}": not a real judgment.` }) };
  }
  async callEmbeddingApi(text) {
    const vector = new Array(64).fill(0);
    for (const word of String(text).toLowerCase().match(/[a-z0-9-]+/g) || []) {
      vector[Math.floor(fraction(word, 'embed') * 64) % 64] += 1;
    }
    return { embedding: vector };
  }
}

module.exports = StandInJudge;
