'use strict';

/**
 * SENTINEL — WhatsApp Service (STUB)
 *
 * Replace the body of each function with your Twilio / WhatsApp Business
 * API integration. Function signatures must remain unchanged.
 */

/**
 * Send a WhatsApp alert to a user.
 *
 * @param {Object} params
 * @param {Object} params.user     - Mongoose User document (lean)
 * @param {Object} params.incident - Mongoose Incident document
 * @returns {Promise<void>}
 */
exports.send = async ({ user, incident }) => {
  // TODO: integrate Twilio / WhatsApp Business API
};

/**
 * Send a bulk broadcast to multiple users.
 *
 * @param {Object[]} users         - Array of lean User documents
 * @param {Object}   incident      - Mongoose Incident document
 * @returns {Promise<void>}
 */
exports.broadcast = async (users, incident) => {
  // TODO: integrate Twilio / WhatsApp Business API
};