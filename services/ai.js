'use strict';

/**
 * SENTINEL — AI Service (STUB)
 *
 * Replace the body of each function with your Gemini / OpenAI / custom LLM
 * integration. Function signatures must remain unchanged.
 */

/**
 * Analyze an incident in the context of a specific user and return
 * an AI-generated advisory payload.
 *
 * @param {Object} params
 * @param {Object} params.user     - Mongoose User document (lean)
 * @param {Object} params.incident - Mongoose Incident document
 * @returns {Promise<Object>}      - Advisory payload (structure TBD by integration)
 */
exports.analyze = async ({ user, incident }) => {
  // TODO: integrate Gemini / LLM API
  return {};
};

/**
 * Generate a natural-language evacuation instruction for a user.
 *
 * @param {Object} user      - Mongoose User document (lean)
 * @param {string} targetNode - Destination node identifier
 * @returns {Promise<string>} - Instruction text
 */
exports.generateInstruction = async (user, targetNode) => {
  // TODO: integrate Gemini / LLM API
  return '';
};

/**
 * Summarise the current incident state for a dashboard or log entry.
 *
 * @param {Object} incident - Mongoose Incident document
 * @returns {Promise<string>} - Human-readable summary
 */
exports.summarize = async (incident) => {
  // TODO: integrate Gemini / LLM API
  return '';
};