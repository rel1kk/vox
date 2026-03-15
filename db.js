const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

// Use persistent volume if available, otherwise local
const dataDir = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const dbPath = path.join(dataDir, 'vox-data.json');

const adapter = new FileSync(dbPath);
const db = low(adapter);

db.defaults({
  users: [],
  posts: [],
  likes: [],
  follows: [],
  messages: [],
  notifications: [],
  comments: [],
  reposts: [],
  bans: [],
  slowdowns: [],
  stories: [],
  polls: [],
  poll_votes: [],
  bookmarks: [],
  reports: [],
  drafts: [],
  notes: [],
  post_views: [],
  msg_reactions: [],
  login_history: [],
  _counters: { users:1, posts:1, messages:1, notifications:1, comments:1, reposts:1, stories:1, polls:1, drafts:1, notes:1, reports:1 }
}).write();

function nextId(table) {
  const val = db.get(`_counters.${table}`).value();
  db.set(`_counters.${table}`, val + 1).write();
  return val;
}

module.exports = { db, nextId };
