// Code checks used by promptfooconfig.code.yaml. No model is involved.

/**
 * Share of the expert's key-term groups that appear in the answer.
 * A group counts once, whichever of its wordings appears. Case is ignored.
 */
module.exports.keyTerms = (output, context) => {
  const groups = (context.config && context.config.groups) || [];
  const text = String(output).toLowerCase();
  const found = groups.filter((group) => group.some((wording) => text.includes(String(wording).toLowerCase())));
  const missing = groups.filter((group) => !found.includes(group));
  return {
    pass: true,
    score: groups.length ? found.length / groups.length : 0,
    reason:
      `${found.length} of ${groups.length} term groups. ` +
      `Found: ${found.map((group) => group[0]).join('; ') || 'none'}. ` +
      `Missing: ${missing.map((group) => group[0]).join('; ') || 'none'}.`,
  };
};
