// api/ebay_deletion.js — eBay Marketplace Account Deletion notification endpoint.
//
// WHY THIS EXISTS, AND WHY IT IS NOT AN EXEMPTION.
// Every active eBay Developers Program application must either subscribe to
// marketplace account deletion notifications or claim an exemption. The
// exemption is only for an application that persists NO eBay data, and eBay's
// own page warns that "failure to provide correct information may result in
// penalties or having their account disabled."
//
// Robograder's planned use is Browse only - public active listings, fetched
// with an application token, no eBay user ever signs in, no buyer or seller
// identity is stored. On that reading the exemption fits. BUT the eBay Browse
// spec has us CACHING item summaries for 24h, and an item summary is eBay
// data. That is a judgement call with account suspension attached, made by a
// solo developer with no legal review, to save about forty lines of code.
// Not worth it. The endpoint removes the judgement call entirely, and it keeps
// being correct if Robograder ever does touch eBay user data.
//
// WHAT IT ACTUALLY HAS TO DO
//   GET  ?challenge_code=XYZ  -> 200 application/json
//                                { challengeResponse: sha256hex(
//                                    challengeCode + verificationToken + endpoint) }
//        THE ORDER OF THOSE THREE IS NOT NEGOTIABLE. Any other order hashes
//        fine and fails eBay's check with no useful error.
//        `endpoint` must be the exact URL registered with eBay, scheme and all.
//   POST (the real notification) -> acknowledge immediately with 200. An
//        unacknowledged notification is resent, repeatedly.
//
// The verification token is 32-80 chars of [A-Za-z0-9_-] ONLY. eBay rejects
// anything else, and it must be byte-identical here and in their form.
//
// ON DELETING DATA: there is nothing to delete. Robograder stores no eBay user
// identifiers, so a deletion notice is acknowledged and logged, not acted on.
// If that ever changes - a user links an eBay account, say - this handler is
// where the deletion has to be implemented, and shipping that feature without
// touching this file would be a compliance failure.

import { createHash } from 'node:crypto';

// The URL REGISTERED WITH EBAY, which is what goes into the hash. Not
// req.headers.host: behind Vercel that can be a deployment-specific hostname
// (robograder-abc123.vercel.app) on a preview or an alias, and hashing that
// instead of the registered URL fails verification in a way that looks random.
const ENDPOINT_URL = process.env.EBAY_DELETION_ENDPOINT
  || 'https://robograder.app/api/ebay_deletion';

export default async function handler(req, res) {
  const token = (process.env.EBAY_VERIFY_TOKEN || '').trim();

  if (req.method === 'GET') {
    const challengeCode = (req.query && (req.query.challenge_code || req.query.challengeCode)) || '';
    if (!challengeCode) {
      return res.status(400).json({ error: 'challenge_code required' });
    }
    if (!token) {
      // Loud, because a silent 500 here reads as "eBay is broken" when in fact
      // the environment variable was never set or the deploy predates it.
      console.error('[ebay_deletion] EBAY_VERIFY_TOKEN is not set — cannot answer the challenge.');
      return res.status(500).json({ error: 'verification token not configured' });
    }
    const hash = createHash('sha256');
    hash.update(String(challengeCode));
    hash.update(token);
    hash.update(ENDPOINT_URL);
    const challengeResponse = hash.digest('hex');
    console.log('[ebay_deletion] challenge answered for', ENDPOINT_URL);
    res.setHeader('Content-Type', 'application/json');
    // res.json, not a hand-built string: a byte order mark in the body is a
    // documented cause of eBay's parser failing on an otherwise correct answer.
    return res.status(200).json({ challengeResponse });
  }

  if (req.method === 'POST') {
    // Acknowledge FIRST and think later. eBay resends anything it does not see
    // acknowledged, and nothing below can fail in a way the sender should wait
    // for. We hold no eBay user data, so there is nothing to erase.
    try {
      const b = req.body || {};
      const d = (b.notification && b.notification.data) || {};
      console.log('[ebay_deletion] notification received',
        JSON.stringify({
          topic: b.topic || null,
          notificationId: (b.notification && b.notification.notificationId) || null,
          // username/userId are logged so there is a record that the notice
          // arrived and was a no-op. Nothing is stored anywhere else.
          username: d.username || null,
          eiasToken: d.eiasToken ? '[present]' : null
        }));
    } catch (e) {
      console.error('[ebay_deletion] could not parse notification (still acknowledging):', e && e.message);
    }
    return res.status(200).end();
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
}
