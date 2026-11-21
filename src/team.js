// Team members ("scanners"): people an organizer invites to scan tickets at the gate.
// They get their own login, can reach the scanner for the organizer's events, and nothing else:
// no earnings, orders, guest lists or settings (every organizer route rejects them).
const db = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const { issueToken, readToken, hashPassword } = require('./auth');
const { httpError } = require('./orders');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEAM = 20;
const joinUrl = (memberId) => `${config.baseUrl}/join.html?token=${encodeURIComponent(issueToken(memberId, false, 'j', 7 * 864e5))}`;

async function listTeam(ownerId) {
  const rows = (await db.query('SELECT id, name, email, invited_at, accepted_at FROM team_members WHERE owner_id = $1 ORDER BY id DESC', [ownerId])).rows;
  return rows.map((r) => ({ ...r, status: r.accepted_at ? 'active' : 'invited' }));
}

async function inviteMember({ ownerId, name, email }) {
  name = String(name || '').trim().slice(0, 80);
  email = String(email || '').trim().toLowerCase();
  if (!name || !EMAIL.test(email)) throw httpError(400, "Enter the team member's name and a valid email address.");
  const count = (await db.query('SELECT COUNT(*) AS n FROM team_members WHERE owner_id = $1', [ownerId])).rows[0].n;
  if (count >= MAX_TEAM) throw httpError(400, `You can have up to ${MAX_TEAM} team members.`);
  if ((await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length) throw httpError(409, 'That email already has a Gatepass account. Ask your team member to use a different email address.');
  const made = await db.query('INSERT INTO team_members (owner_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id', [ownerId, name, email]);
  if (!made.rows.length) throw httpError(409, 'That email has already been invited.');
  const id = made.rows[0].id;
  const owner = (await db.query('SELECT name FROM users WHERE id = $1', [ownerId])).rows[0];
  try {
    await mailer.sendTeamInviteEmail({ to: email, name, ownerName: owner.name, url: joinUrl(id) });
  } catch (err) {
    await db.query('DELETE FROM team_members WHERE id = $1', [id]);          // do not leave an invitation nobody received
    console.error('[mail] failed:', err.message);
    throw httpError(502, 'We could not send the invitation email. Check the address and try again.');
  }
  return { id, inviteUrl: mailer.mode === 'console' ? joinUrl(id) : undefined };      // with no email service, the owner can pass the link on
}

async function resendInvite({ ownerId, memberId }) {
  const m = (await db.query('SELECT m.id, m.name, m.email, u.name AS owner_name FROM team_members m JOIN users u ON u.id = m.owner_id WHERE m.id = $1 AND m.owner_id = $2 AND m.accepted_at IS NULL', [memberId, ownerId])).rows[0];
  if (!m) throw httpError(404, 'Invitation not found.');
  try { await mailer.sendTeamInviteEmail({ to: m.email, name: m.name, ownerName: m.owner_name, url: joinUrl(m.id) }); }
  catch (err) { console.error('[mail] failed:', err.message); throw httpError(502, 'We could not send the email. Please try again.'); }
  return { inviteUrl: mailer.mode === 'console' ? joinUrl(m.id) : undefined };
}

// Removing someone deletes their login straight away, so their next request is refused.
async function removeMember({ ownerId, memberId }) {
  return db.tx(async (q) => {
    const m = (await q('SELECT id, user_id FROM team_members WHERE id = $1 AND owner_id = $2 FOR UPDATE', [memberId, ownerId])).rows[0];
    if (!m) throw httpError(404, 'Team member not found.');
    await q('DELETE FROM team_members WHERE id = $1', [m.id]);
    if (m.user_id) await q("DELETE FROM users WHERE id = $1 AND role = 'scanner'", [m.user_id]);
    return { ok: true };
  });
}

async function openInvite(token) {
  const data = readToken(String(token || ''), 'j');
  const m = data && (await db.query('SELECT m.id, m.name, m.email, m.accepted_at, u.name AS owner_name FROM team_members m JOIN users u ON u.id = m.owner_id WHERE m.id = $1', [data.uid])).rows[0];
  if (!m || m.accepted_at) throw httpError(400, 'This invitation has expired, was already used, or was cancelled. Ask for a new one.');
  return m;
}
const joinInfo = async (token) => { const m = await openInvite(token); return { name: m.name, email: m.email, ownerName: m.owner_name }; };

async function acceptInvite({ token, password }) {
  password = String(password || '').slice(0, 200);
  if (password.length < 8) throw httpError(400, 'Use a password of at least 8 characters.');
  const m = await openInvite(token);
  return db.tx(async (q) => {
    const fresh = (await q('SELECT id, owner_id, name, email, accepted_at FROM team_members WHERE id = $1 FOR UPDATE', [m.id])).rows[0];
    if (!fresh || fresh.accepted_at) throw httpError(400, 'This invitation was already used.');
    if ((await q('SELECT 1 FROM users WHERE email = $1', [fresh.email])).rows.length) throw httpError(409, 'That email already has a Gatepass account.');
    const user = await q("INSERT INTO users (name, email, password_hash, email_verified, role, owner_id) VALUES ($1, $2, $3, TRUE, 'scanner', $4) RETURNING id", [fresh.name, fresh.email, hashPassword(password), fresh.owner_id]);
    await q('UPDATE team_members SET user_id = $2, accepted_at = NOW() WHERE id = $1', [fresh.id, user.rows[0].id]);
    return { ok: true, email: fresh.email };       // they received the invitation by email, so the address counts as confirmed
  });
}

module.exports = { listTeam, inviteMember, resendInvite, removeMember, joinInfo, acceptInvite };
