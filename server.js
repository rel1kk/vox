const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, nextId } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = 'tigra';
const ADMIN_PASS = 'madja1986';
const VERIFY_CODE = 'supervox9000';
const GIPHY_KEY = 'GlVGYHkr3WSBnllca54iNt0yFbjz7L3'; // public beta key

app.use(session({
  store: new FileStore({ path: path.join(__dirname, 'sessions'), retries: 1 }),
  secret: process.env.SECRET || 'vox_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

['sessions','public/uploads','public/voices','public/music','public/gifs','public/avatars'].forEach(d => {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

function makeStorage(sub) {
  return multer.diskStorage({
    destination: (req,file,cb) => cb(null, path.join(__dirname,'public',sub)),
    filename: (req,file,cb) => cb(null, Date.now()+'_'+Math.random().toString(36).slice(2)+path.extname(file.originalname))
  });
}
const uploadImage  = multer({ storage: makeStorage('uploads'), limits:{fileSize:10*1024*1024} });
const uploadVoice  = multer({ storage: makeStorage('voices'),  limits:{fileSize:20*1024*1024} });
const uploadMusic  = multer({ storage: makeStorage('music'),   limits:{fileSize:20*1024*1024} });
const uploadAvatar = multer({ storage: makeStorage('avatars'), limits:{fileSize:5*1024*1024}  });

const auth = (req,res,next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
  const ban = db.get('bans').find(b => b.user_id===req.session.userId && (b.until===0 || b.until>Date.now())).value();
  if (ban) return res.status(403).json({ error: 'Вы заблокированы', ban });
  next();
};
const adminOnly = (req,res,next) => {
  const u = getUser(req.session.userId);
  if (!u || u.username !== ADMIN_USER) return res.status(403).json({ error: 'Нет доступа' });
  next();
};

function timeAgo(ts) {
  const d = Math.floor((Date.now()-ts)/1000);
  if(d<60) return 'только что';
  if(d<3600) return Math.floor(d/60)+' мин назад';
  if(d<86400) return Math.floor(d/3600)+' ч назад';
  return Math.floor(d/86400)+' д назад';
}

// MODERATION
const BANNED_18 = ['порно','porno','porn','xxx','эротика','nude','nudes','голая','голый','стриптиз','onlyfans'];
const WORD_REPLACE = [
  { from: /роскомнадзор/gi, to: 'Запрещено' },
  { from: /\bРКН\b/g, to: 'Запрещено' },
];
function moderateText(text) {
  if (!text) return { ok:true, text:'' };
  const lower = text.toLowerCase();
  for (const w of BANNED_18) if(lower.includes(w)) return { ok:false, reason:'18+ контент запрещён на VOX' };
  let result = text;
  for (const r of WORD_REPLACE) result = result.replace(r.from, r.to);
  return { ok:true, text:result };
}
function trackView(postId, userId) {
  if (!db.get('post_views').find({post_id:postId,user_id:userId}).value())
    db.get('post_views').push({post_id:postId,user_id:userId,ts:Date.now()}).write();
}

function getUser(id) { return db.get('users').find({id}).value(); }
function enrichUser(u, meId) {
  if(!u) return null;
  const followers   = db.get('follows').filter({following_id:u.id}).size().value();
  const following   = db.get('follows').filter({follower_id:u.id}).size().value();
  const posts_count = db.get('posts').filter({user_id:u.id}).size().value();
  const is_following = meId ? !!db.get('follows').find({follower_id:meId,following_id:u.id}).value() : false;
  const ban = db.get('bans').find(b=>b.user_id===u.id&&(b.until===0||b.until>Date.now())).value();
  return { ...u, password:undefined, followers, following, posts_count, is_following, is_me:u.id===meId, is_banned:!!ban, ban_reason:ban?.reason||'' };
}
function enrichPost(p, meId) {
  const u = getUser(p.user_id)||{};
  const liked = meId ? !!db.get('likes').find({user_id:meId,post_id:p.id}).value() : false;
  const reposted = meId ? !!db.get('reposts').find({user_id:meId,post_id:p.id}).value() : false;
  const comments_count = db.get('comments').filter({post_id:p.id}).size().value();
  const reposts_count = db.get('reposts').filter({post_id:p.id}).size().value();
  const views_count = db.get('post_views').filter({post_id:p.id}).size().value();
  const bookmarked = meId ? !!db.get('bookmarks').find({user_id:meId,post_id:p.id}).value() : false;
  return { ...p, name:u.name||'?', username:u.username||'?', color:u.color||'#c8ff00', avatar:u.avatar||'', verified:u.verified||false, liked, reposted, comments_count, reposts_count, views_count, bookmarked, time_ago:timeAgo(p.created_at) };
}

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/register', async (req,res) => {
  let { name, username, password } = req.body;
  username = (username||'').toLowerCase().replace(/[^a-z0-9_]/g,'').trim();
  if (!name||!username||!password) return res.json({error:'Заполни все поля'});
  if (password.length<6) return res.json({error:'Пароль минимум 6 символов'});
  if (db.get('users').find({username}).value()) return res.json({error:'Логин уже занят'});
  const colors = ['#c8ff00','#7c5cfc','#00d4ff','#ff9500','#00ff9f','#ff6b6b'];
  const color = colors[Math.floor(Math.random()*colors.length)];
  const id = nextId('users');
  const hash = await bcrypt.hash(password,10);
  const isAdmin = username===ADMIN_USER;
  db.get('users').push({id,name,username,password:hash,bio:'',color,avatar:'',music:'',verified:isAdmin,is_admin:isAdmin,created_at:Date.now()}).write();
  db.get('notifications').push({id:nextId('notifications'),user_id:id,icon:'🎉',text:`Добро пожаловать на VOX, <b>${name}</b>!`,read:false,created_at:Date.now()}).write();
  req.session.userId=id;
  res.json({ok:true,user:{id,name,username,color,bio:'',avatar:'',music:'',verified:isAdmin,is_admin:isAdmin}});
});

app.post('/api/login', async (req,res) => {
  let { username, password } = req.body;
  username = (username||'').toLowerCase().trim();
  // Special admin hardcoded check
  if (username===ADMIN_USER && password===ADMIN_PASS) {
    let user = db.get('users').find({username:ADMIN_USER}).value();
    if (!user) {
      const hash = await bcrypt.hash(ADMIN_PASS,10);
      const id = nextId('users');
      user = {id,name:'Tigra',username:ADMIN_USER,password:hash,bio:'Администратор VOX',color:'#c8ff00',avatar:'',music:'',verified:true,is_admin:true,created_at:Date.now()};
      db.get('users').push(user).write();
    } else {
      db.get('users').find({username:ADMIN_USER}).assign({verified:true,is_admin:true}).write();
      user = db.get('users').find({username:ADMIN_USER}).value();
    }
    req.session.userId=user.id;
    return res.json({ok:true,user:{...user,password:undefined}});
  }
  const user = db.get('users').find({username}).value();
  if (!user||!(await bcrypt.compare(password,user.password))) return res.json({error:'Неверный логин или пароль'});
  const ban = db.get('bans').find(b=>b.user_id===user.id&&(b.until===0||b.until>Date.now())).value();
  if (ban) return res.json({error:`Вы заблокированы${ban.reason?' ('+ban.reason+')':''}`});
  req.session.userId=user.id;
  db.get('login_history').push({user_id:user.id,ip:req.ip||'unknown',ua:(req.headers['user-agent']||'').slice(0,80),created_at:Date.now()}).write();
  res.json({ok:true,user:{...user,password:undefined}});
});

app.post('/api/logout',(req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

app.get('/api/me',(req,res)=>{
  if(!req.session.userId) return res.json({user:null});
  const u=getUser(req.session.userId); if(!u) return res.json({user:null});
  res.json({user:enrichUser(u,req.session.userId)});
});
app.put('/api/me',auth,(req,res)=>{
  const {name,bio,color}=req.body;
  db.get('users').find({id:req.session.userId}).assign({name,bio,color}).write();
  res.json({ok:true});
});
app.post('/api/me/avatar',auth,uploadAvatar.single('avatar'),(req,res)=>{
  if(!req.file) return res.json({error:'Нет файла'});
  const url='/avatars/'+req.file.filename;
  db.get('users').find({id:req.session.userId}).assign({avatar:url}).write();
  res.json({ok:true,url});
});
app.post('/api/me/music',auth,uploadMusic.single('music'),(req,res)=>{
  if(!req.file) return res.json({error:'Нет файла'});
  const url='/music/'+req.file.filename;
  db.get('users').find({id:req.session.userId}).assign({music:url}).write();
  res.json({ok:true,url});
});
app.post('/api/me/verify',auth,(req,res)=>{
  if(req.body.code!==VERIFY_CODE) return res.json({error:'Неверный код'});
  db.get('users').find({id:req.session.userId}).assign({verified:true}).write();
  res.json({ok:true});
});

// ── USERS ─────────────────────────────────────────────────────
app.get('/api/users/:username',auth,(req,res)=>{
  const u=db.get('users').find({username:req.params.username}).value();
  if(!u) return res.status(404).json({error:'Не найден'});
  res.json({user:enrichUser(u,req.session.userId)});
});
app.post('/api/follow/:id',auth,(req,res)=>{
  const targetId=parseInt(req.params.id), me=req.session.userId;
  if(targetId===me) return res.json({error:'Нельзя'});
  const ex=db.get('follows').find({follower_id:me,following_id:targetId}).value();
  if(ex){ db.get('follows').remove({follower_id:me,following_id:targetId}).write(); res.json({following:false}); }
  else {
    db.get('follows').push({follower_id:me,following_id:targetId}).write();
    const mu=getUser(me);
    db.get('notifications').push({id:nextId('notifications'),user_id:targetId,icon:'👤',text:`<b>${mu.name}</b> подписался на вас`,read:false,created_at:Date.now()}).write();
    res.json({following:true});
  }
});
app.get('/api/search',auth,(req,res)=>{
  const q=(req.query.q||'').toLowerCase();
  const users=db.get('users').filter(u=>u.id!==req.session.userId&&(u.username.includes(q)||u.name.toLowerCase().includes(q))).take(10).value();
  res.json({users:users.map(u=>enrichUser(u,req.session.userId))});
});
app.get('/api/suggested',auth,(req,res)=>{
  const following=db.get('follows').filter({follower_id:req.session.userId}).map('following_id').value();
  const users=db.get('users').filter(u=>u.id!==req.session.userId&&!following.includes(u.id)).take(6).value();
  res.json({users:users.map(u=>({id:u.id,name:u.name,username:u.username,color:u.color,avatar:u.avatar||'',verified:u.verified||false,is_following:false}))});
});

// ── POSTS ─────────────────────────────────────────────────────
app.get('/api/feed',auth,(req,res)=>{
  const posts=db.get('posts').filter(p=>!p.deleted).orderBy('created_at','desc').take(100).value();
  res.json({posts:posts.map(p=>enrichPost(p,req.session.userId))});
});
app.get('/api/feed/since/:ts',auth,(req,res)=>{
  const since=parseInt(req.params.ts);
  const posts=db.get('posts').filter(p=>!p.deleted&&p.created_at>since).orderBy('created_at','desc').value();
  res.json({posts:posts.map(p=>enrichPost(p,req.session.userId))});
});
app.get('/api/users/:username/posts',auth,(req,res)=>{
  const u=db.get('users').find({username:req.params.username}).value();
  if(!u) return res.json({posts:[]});
  const posts=db.get('posts').filter(p=>!p.deleted&&p.user_id===u.id).orderBy('created_at','desc').value();
  res.json({posts:posts.map(p=>enrichPost(p,req.session.userId))});
});

function makePost(req,res,extra={}) {
  const rawText=req.body.text||extra.text||'';
  const mod=moderateText(rawText);
  if(!mod.ok) return res.json({error:mod.reason});
  if(!mod.text&&!extra.image&&!extra.voice&&!extra.gif) return res.json({error:'Пустой пост'});
  const id=nextId('posts');
  const post={id,user_id:req.session.userId,text:mod.text,image:'',voice:'',gif:'',likes_count:0,views:0,pinned:false,archived:false,deleted:false,created_at:Date.now(),...extra,text:mod.text};
  db.get('posts').push(post).write();
  res.json({post:enrichPost(post,req.session.userId)});
}
app.post('/api/posts',auth,uploadImage.single('image'),(req,res)=>makePost(req,res,{image:req.file?'/uploads/'+req.file.filename:''}));
app.post('/api/posts/voice',auth,uploadVoice.single('voice'),(req,res)=>makePost(req,res,{voice:req.file?'/voices/'+req.file.filename:'',text:req.body.text||'🎤'}));
app.post('/api/posts/gif',auth,(req,res)=>{
  const {text,gif_url}=req.body;
  makePost(req,res,{gif:gif_url||'',text:text||''});
});

app.delete('/api/posts/:id',auth,(req,res)=>{
  const postId=parseInt(req.params.id);
  const me=req.session.userId; const meUser=getUser(me);
  const post=db.get('posts').find({id:postId}).value();
  if(!post) return res.status(404).json({error:'Не найден'});
  if(post.user_id!==me && meUser.username!==ADMIN_USER) return res.status(403).json({error:'Нет доступа'});
  db.get('posts').find({id:postId}).assign({deleted:true}).write();
  res.json({ok:true});
});

app.post('/api/posts/:id/like',auth,(req,res)=>{
  const postId=parseInt(req.params.id), me=req.session.userId;
  const ex=db.get('likes').find({user_id:me,post_id:postId}).value();
  if(ex){ db.get('likes').remove({user_id:me,post_id:postId}).write(); db.get('posts').find({id:postId}).update('likes_count',n=>Math.max(0,n-1)).write(); res.json({liked:false}); }
  else {
    db.get('likes').push({user_id:me,post_id:postId}).write();
    db.get('posts').find({id:postId}).update('likes_count',n=>n+1).write();
    const post=db.get('posts').find({id:postId}).value();
    if(post&&post.user_id!==me){ const mu=getUser(me); db.get('notifications').push({id:nextId('notifications'),user_id:post.user_id,icon:'❤️',text:`<b>${mu.name}</b> лайкнул ваш пост`,read:false,created_at:Date.now()}).write(); }
    res.json({liked:true});
  }
});

app.post('/api/posts/:id/repost',auth,(req,res)=>{
  const postId=parseInt(req.params.id), me=req.session.userId;
  const ex=db.get('reposts').find({user_id:me,post_id:postId}).value();
  if(ex){ db.get('reposts').remove({user_id:me,post_id:postId}).write(); res.json({reposted:false}); }
  else {
    db.get('reposts').push({user_id:me,post_id:postId,created_at:Date.now()}).write();
    const post=db.get('posts').find({id:postId}).value();
    if(post&&post.user_id!==me){ const mu=getUser(me); db.get('notifications').push({id:nextId('notifications'),user_id:post.user_id,icon:'🔁',text:`<b>${mu.name}</b> сделал репост`,read:false,created_at:Date.now()}).write(); }
    res.json({reposted:true});
  }
});

// ── COMMENTS ──────────────────────────────────────────────────
app.get('/api/posts/:id/comments',auth,(req,res)=>{
  const postId=parseInt(req.params.id);
  const comments=db.get('comments').filter({post_id:postId}).orderBy('created_at','asc').value();
  const result=comments.map(c=>{ const u=getUser(c.user_id)||{}; return {...c,name:u.name,username:u.username,color:u.color,avatar:u.avatar||'',verified:u.verified||false,time_ago:timeAgo(c.created_at)}; });
  res.json({comments:result});
});
app.post('/api/posts/:id/comments',auth,(req,res)=>{
  const postId=parseInt(req.params.id), me=req.session.userId;
  const {text}=req.body; if(!text) return res.json({error:'Пустой комментарий'});
  const id=nextId('comments');
  const comment={id,post_id:postId,user_id:me,text,created_at:Date.now()};
  db.get('comments').push(comment).write();
  const post=db.get('posts').find({id:postId}).value();
  if(post&&post.user_id!==me){ const mu=getUser(me); db.get('notifications').push({id:nextId('notifications'),user_id:post.user_id,icon:'💬',text:`<b>${mu.name}</b> прокомментировал: ${text.slice(0,40)}`,read:false,created_at:Date.now()}).write(); }
  const u=getUser(me)||{};
  res.json({comment:{...comment,name:u.name,username:u.username,color:u.color,avatar:u.avatar||'',verified:u.verified||false,time_ago:'только что'}});
});
app.delete('/api/comments/:id',auth,(req,res)=>{
  const cid=parseInt(req.params.id), me=req.session.userId; const meUser=getUser(me);
  const c=db.get('comments').find({id:cid}).value(); if(!c) return res.status(404).json({error:'Нет'});
  if(c.user_id!==me&&meUser.username!==ADMIN_USER) return res.status(403).json({error:'Нет доступа'});
  db.get('comments').remove({id:cid}).write();
  res.json({ok:true});
});

// ── MESSAGES ──────────────────────────────────────────────────
app.get('/api/conversations',auth,(req,res)=>{
  const me=req.session.userId;
  const msgs=db.get('messages').filter(m=>m.from_id===me||m.to_id===me).value();
  const pids=[...new Set(msgs.map(m=>m.from_id===me?m.to_id:m.from_id))];
  const convs=pids.map(pid=>{ const u=getUser(pid); if(!u)return null; const last=db.get('messages').filter(m=>(m.from_id===me&&m.to_id===pid)||(m.from_id===pid&&m.to_id===me)).orderBy('created_at','desc').first().value(); return {user:{id:u.id,name:u.name,username:u.username,color:u.color,avatar:u.avatar||'',verified:u.verified||false},last_message:last?last.text:'',last_time:last?timeAgo(last.created_at):''}; }).filter(Boolean);
  res.json({conversations:convs});
});
app.get('/api/messages/:userId',auth,(req,res)=>{
  const me=req.session.userId, other=parseInt(req.params.userId);
  const msgs=db.get('messages').filter(m=>(m.from_id===me&&m.to_id===other)||(m.from_id===other&&m.to_id===me)).orderBy('created_at','asc').value();
  res.json({messages:msgs.map(m=>{const u=getUser(m.from_id)||{};return{...m,name:u.name,color:u.color,avatar:u.avatar||'',time_ago:timeAgo(m.created_at)};})});
});
app.post('/api/messages/:userId',auth,(req,res)=>{
  const me=req.session.userId, other=parseInt(req.params.userId);
  const {text}=req.body; if(!text) return res.json({error:'Пустое'});
  const id=nextId('messages');
  const msg={id,from_id:me,to_id:other,text,voice:'',gif:'',created_at:Date.now()};
  db.get('messages').push(msg).write();
  const mu=getUser(me);
  db.get('notifications').push({id:nextId('notifications'),user_id:other,icon:'💬',text:`<b>${mu.name}</b>: ${text.slice(0,40)}`,read:false,created_at:Date.now()}).write();
  res.json({message:{...msg,name:mu.name,color:mu.color,avatar:mu.avatar||'',time_ago:'только что'}});
});
app.post('/api/messages/:userId/voice',auth,uploadVoice.single('voice'),(req,res)=>{
  const me=req.session.userId, other=parseInt(req.params.userId);
  if(!req.file) return res.json({error:'Нет файла'});
  const voice='/voices/'+req.file.filename;
  const id=nextId('messages'); const msg={id,from_id:me,to_id:other,text:'🎤',voice,gif:'',created_at:Date.now()};
  db.get('messages').push(msg).write();
  const mu=getUser(me); db.get('notifications').push({id:nextId('notifications'),user_id:other,icon:'🎤',text:`<b>${mu.name}</b> прислал голосовое`,read:false,created_at:Date.now()}).write();
  res.json({message:{...msg,name:mu.name,color:mu.color,avatar:mu.avatar||'',time_ago:'только что'}});
});
app.post('/api/messages/:userId/gif',auth,(req,res)=>{
  const me=req.session.userId, other=parseInt(req.params.userId);
  const {gif_url}=req.body; if(!gif_url) return res.json({error:'Нет gif'});
  const id=nextId('messages'); const msg={id,from_id:me,to_id:other,text:'',voice:'',gif:gif_url,created_at:Date.now()};
  db.get('messages').push(msg).write();
  const mu=getUser(me); db.get('notifications').push({id:nextId('notifications'),user_id:other,icon:'🎞️',text:`<b>${mu.name}</b> прислал GIF`,read:false,created_at:Date.now()}).write();
  res.json({message:{...msg,name:mu.name,color:mu.color,avatar:mu.avatar||'',time_ago:'только что'}});
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
app.get('/api/notifications',auth,(req,res)=>{
  const notifs=db.get('notifications').filter({user_id:req.session.userId}).orderBy('created_at','desc').take(30).value();
  res.json({notifications:notifs.map(n=>({...n,time_ago:timeAgo(n.created_at)})),unread:notifs.filter(n=>!n.read).length});
});
app.post('/api/notifications/read',auth,(req,res)=>{
  db.get('notifications').filter({user_id:req.session.userId}).each(n=>{n.read=true;}).write();
  res.json({ok:true});
});

// ── ADMIN ─────────────────────────────────────────────────────
app.get('/api/admin/users',auth,adminOnly,(req,res)=>{
  const users=db.get('users').value().map(u=>enrichUser(u,req.session.userId));
  res.json({users});
});
app.post('/api/admin/ban',auth,adminOnly,(req,res)=>{
  const {user_id,reason,duration}=req.body; // duration: 0=forever, else hours
  const until = duration===0 ? 0 : Date.now()+(parseInt(duration)||24)*3600*1000;
  db.get('bans').remove({user_id}).write();
  db.get('bans').push({user_id,reason:reason||'',until,by:req.session.userId,created_at:Date.now()}).write();
  const u=getUser(user_id);
  if(u) db.get('notifications').push({id:nextId('notifications'),user_id,icon:'🚫',text:`Вы заблокированы${reason?' ('+reason+')':''}`,read:false,created_at:Date.now()}).write();
  res.json({ok:true});
});
app.post('/api/admin/unban',auth,adminOnly,(req,res)=>{
  const {user_id}=req.body;
  db.get('bans').remove({user_id}).write();
  const u=getUser(user_id);
  if(u) db.get('notifications').push({id:nextId('notifications'),user_id,icon:'✅',text:'Ваша блокировка снята',read:false,created_at:Date.now()}).write();
  res.json({ok:true});
});
app.post('/api/admin/verify',auth,adminOnly,(req,res)=>{
  const {user_id,verified}=req.body;
  db.get('users').find({id:user_id}).assign({verified:!!verified}).write();
  const u=getUser(user_id);
  if(u) db.get('notifications').push({id:nextId('notifications'),user_id,icon:verified?'⚙️':'❌',text:verified?'Вы получили значок верификации ⚙️':'Ваш значок верификации снят',read:false,created_at:Date.now()}).write();
  res.json({ok:true});
});
app.post('/api/admin/slowdown',auth,adminOnly,(req,res)=>{
  const {user_id,enabled}=req.body;
  if(enabled){
    if(!db.get('slowdowns').find({user_id}).value())
      db.get('slowdowns').push({user_id,created_at:Date.now()}).write();
  } else {
    db.get('slowdowns').remove({user_id}).write();
  }
  const u=getUser(user_id);
  if(u){
    const icon=enabled?'🐢':'✅';
    const text=enabled?'Вас замедлили. Доступ к сети ограничен.':'Замедление снято';
    db.get('notifications').push({id:nextId('notifications'),user_id,icon,text,read:false,created_at:Date.now()}).write();
  }
  res.json({ok:true});
});
app.get('/api/slowdown/check',auth,(req,res)=>{
  const slowed=!!db.get('slowdowns').find({user_id:req.session.userId}).value();
  res.json({slowed});
});
app.get('/api/settings',auth,(req,res)=>{
  const u=getUser(req.session.userId);
  res.json({settings:u?.settings||{notifications:true}});
});
app.put('/api/settings',auth,(req,res)=>{
  db.get('users').find({id:req.session.userId}).assign({settings:req.body.settings}).write();
  res.json({ok:true});
});
app.get('/api/admin/slowdowns',auth,adminOnly,(req,res)=>{
  const slowdowns=db.get('slowdowns').value();
  res.json({slowdowns});
});
app.get('/api/admin/stats',auth,adminOnly,(req,res)=>{
  res.json({
    users: db.get('users').size().value(),
    posts: db.get('posts').filter(p=>!p.deleted).size().value(),
    comments: db.get('comments').size().value(),
    messages: db.get('messages').size().value(),
    bans: db.get('bans').size().value(),
  });
});

// ── GIPHY PROXY ───────────────────────────────────────────────
const https = require('https');
app.get('/api/giphy/trending',(req,res)=>{
  const url=`https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24&rating=g`;
  https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.json({data:[]});}});}).on('error',()=>res.json({data:[]}));
});
app.get('/api/giphy/search',(req,res)=>{
  const q=encodeURIComponent(req.query.q||'funny');
  const url=`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${q}&limit=24&rating=g`;
  https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.json({data:[]});}});}).on('error',()=>res.json({data:[]}));
});

// ── SLOWDOWN ──────────────────────────────────────────────────
app.post('/api/admin/slowdown',auth,adminOnly,(req,res)=>{
  const {user_id,enabled}=req.body;
  if(enabled){
    if(!db.get('slowdowns').find({user_id}).value())
      db.get('slowdowns').push({user_id,created_at:Date.now()}).write();
  } else {
    db.get('slowdowns').remove({user_id}).write();
  }
  const u=getUser(user_id);
  if(u){
    const icon=enabled?'🐢':'✅';
    const text=enabled?'Ваш аккаунт был замедлён администратором':'Замедление снято';
    db.get('notifications').push({id:nextId('notifications'),user_id,icon,text,read:false,created_at:Date.now()}).write();
  }
  res.json({ok:true});
});

app.get('/api/slowdown/check',auth,(req,res)=>{
  const slowed=!!db.get('slowdowns').find({user_id:req.session.userId}).value();
  res.json({slowed});
});

// ── SETTINGS ──────────────────────────────────────────────────
app.get('/api/settings',auth,(req,res)=>{
  const u=getUser(req.session.userId);
  res.json({settings:u?.settings||{notifications:true}});
});
app.put('/api/settings',auth,(req,res)=>{
  const {settings}=req.body;
  db.get('users').find({id:req.session.userId}).assign({settings}).write();
  res.json({ok:true});
});

// ── STORIES ───────────────────────────────────────────────────
app.post('/api/stories', auth, (req,res) => {
  const {text,bg} = req.body;
  const mod = moderateText(text);
  if(!mod.ok) return res.json({error:mod.reason});
  const id = nextId('stories');
  const story = {id, user_id:req.session.userId, text:mod.text, bg:bg||'#7c5cfc', expires_at:Date.now()+86400000, created_at:Date.now()};
  db.get('stories').push(story).write();
  res.json({story});
});
app.get('/api/stories', auth, (req,res) => {
  const now = Date.now();
  const stories = db.get('stories').filter(s=>s.expires_at>now).orderBy('created_at','desc').value();
  const result = stories.map(s=>{ const u=getUser(s.user_id)||{}; return {...s,name:u.name,username:u.username,color:u.color,avatar:u.avatar||'',verified:u.verified||false}; });
  res.json({stories:result});
});

// ── POLLS ─────────────────────────────────────────────────────
app.post('/api/polls', auth, (req,res) => {
  const {question, options} = req.body;
  const mod = moderateText(question);
  if(!mod.ok) return res.json({error:mod.reason});
  if(!options||options.length<2) return res.json({error:'Нужно минимум 2 варианта'});
  const id = nextId('polls');
  const post_id = nextId('posts');
  const poll = {id, post_id, question:mod.text, options, created_at:Date.now()};
  db.get('polls').push(poll).write();
  const u = getUser(req.session.userId);
  const post = {id:post_id, user_id:req.session.userId, text:'📊 '+mod.text, image:'',voice:'',gif:'',poll_id:id,likes_count:0,views:0,pinned:false,archived:false,deleted:false,created_at:Date.now()};
  db.get('posts').push(post).write();
  res.json({post:enrichPost(post,req.session.userId), poll});
});
app.post('/api/polls/:id/vote', auth, (req,res) => {
  const pollId=parseInt(req.params.id), me=req.session.userId;
  const {option} = req.body;
  const existing = db.get('poll_votes').find({poll_id:pollId,user_id:me}).value();
  if(existing) return res.json({error:'Уже проголосовал'});
  db.get('poll_votes').push({poll_id:pollId,user_id:me,option,created_at:Date.now()}).write();
  const votes = db.get('poll_votes').filter({poll_id:pollId}).value();
  const poll = db.get('polls').find({id:pollId}).value();
  const counts = {};
  if(poll) poll.options.forEach(o=>counts[o]=0);
  votes.forEach(v=>{ if(counts[v.option]!==undefined) counts[v.option]++; });
  res.json({ok:true, counts, total:votes.length, my_vote:option});
});
app.get('/api/polls/:id', auth, (req,res) => {
  const pollId=parseInt(req.params.id), me=req.session.userId;
  const poll = db.get('polls').find({id:pollId}).value();
  if(!poll) return res.json({error:'Нет'});
  const votes = db.get('poll_votes').filter({poll_id:pollId}).value();
  const counts = {}; poll.options.forEach(o=>counts[o]=0);
  votes.forEach(v=>{ if(counts[v.option]!==undefined) counts[v.option]++; });
  const my_vote = (db.get('poll_votes').find({poll_id:pollId,user_id:me}).value()||{}).option||null;
  res.json({poll, counts, total:votes.length, my_vote});
});

// ── BOOKMARKS ─────────────────────────────────────────────────
app.post('/api/bookmarks/:postId', auth, (req,res) => {
  const postId=parseInt(req.params.postId), me=req.session.userId;
  const ex = db.get('bookmarks').find({user_id:me,post_id:postId}).value();
  if(ex){ db.get('bookmarks').remove({user_id:me,post_id:postId}).write(); res.json({saved:false}); }
  else { db.get('bookmarks').push({user_id:me,post_id:postId,created_at:Date.now()}).write(); res.json({saved:true}); }
});
app.get('/api/bookmarks', auth, (req,res) => {
  const me=req.session.userId;
  const bms = db.get('bookmarks').filter({user_id:me}).orderBy('created_at','desc').value();
  const posts = bms.map(b=>{ const p=db.get('posts').find({id:b.post_id}).value(); return p&&!p.deleted?enrichPost(p,me):null; }).filter(Boolean);
  res.json({posts});
});

// ── DRAFTS ────────────────────────────────────────────────────
app.get('/api/drafts', auth, (req,res) => {
  const drafts = db.get('drafts').filter({user_id:req.session.userId}).orderBy('created_at','desc').value();
  res.json({drafts});
});
app.post('/api/drafts', auth, (req,res) => {
  const {text} = req.body;
  if(!text) return res.json({error:'Пусто'});
  const id = nextId('drafts');
  const draft = {id, user_id:req.session.userId, text, created_at:Date.now()};
  db.get('drafts').push(draft).write();
  res.json({draft});
});
app.delete('/api/drafts/:id', auth, (req,res) => {
  db.get('drafts').remove({id:parseInt(req.params.id),user_id:req.session.userId}).write();
  res.json({ok:true});
});

// ── NOTES (private diary) ─────────────────────────────────────
app.get('/api/notes', auth, (req,res) => {
  const notes = db.get('notes').filter({user_id:req.session.userId}).orderBy('created_at','desc').value();
  res.json({notes});
});
app.post('/api/notes', auth, (req,res) => {
  const {text,title} = req.body; if(!text) return res.json({error:'Пусто'});
  const id = nextId('notes');
  const note = {id, user_id:req.session.userId, title:title||'Заметка', text, created_at:Date.now()};
  db.get('notes').push(note).write();
  res.json({note});
});
app.delete('/api/notes/:id', auth, (req,res) => {
  db.get('notes').remove({id:parseInt(req.params.id),user_id:req.session.userId}).write();
  res.json({ok:true});
});

// ── POST VIEWS ────────────────────────────────────────────────
app.post('/api/posts/:id/view', auth, (req,res) => {
  trackView(parseInt(req.params.id), req.session.userId);
  res.json({ok:true});
});

// ── POST SEARCH ───────────────────────────────────────────────
app.get('/api/search/posts', auth, (req,res) => {
  const q=(req.query.q||'').toLowerCase();
  if(!q) return res.json({posts:[]});
  const posts = db.get('posts').filter(p=>!p.deleted&&p.text&&p.text.toLowerCase().includes(q)).orderBy('created_at','desc').take(30).value();
  res.json({posts:posts.map(p=>enrichPost(p,req.session.userId))});
});

// ── PIN / ARCHIVE ─────────────────────────────────────────────
app.post('/api/posts/:id/pin', auth, (req,res) => {
  const postId=parseInt(req.params.id), me=req.session.userId;
  const post = db.get('posts').find({id:postId,user_id:me}).value();
  if(!post) return res.status(403).json({error:'Нет доступа'});
  const pinned = !post.pinned;
  if(pinned) db.get('posts').filter({user_id:me}).each(p=>{ p.pinned=false; }).write();
  db.get('posts').find({id:postId}).assign({pinned}).write();
  res.json({pinned});
});
app.post('/api/posts/:id/archive', auth, (req,res) => {
  const postId=parseInt(req.params.id), me=req.session.userId;
  const post = db.get('posts').find({id:postId,user_id:me}).value();
  if(!post) return res.status(403).json({error:'Нет доступа'});
  db.get('posts').find({id:postId}).assign({archived:!post.archived}).write();
  res.json({archived:!post.archived});
});

// ── REPORTS ───────────────────────────────────────────────────
app.post('/api/reports', auth, (req,res) => {
  const {target_id, target_type, reason} = req.body;
  const id = nextId('reports');
  db.get('reports').push({id,reporter_id:req.session.userId,target_id,target_type,reason,resolved:false,created_at:Date.now()}).write();
  res.json({ok:true});
});
app.get('/api/admin/reports', auth, adminOnly, (req,res) => {
  const reports = db.get('reports').filter({resolved:false}).orderBy('created_at','desc').value();
  const result = reports.map(r=>{ const u=getUser(r.reporter_id)||{}; return {...r,reporter_name:u.name,reporter_username:u.username}; });
  res.json({reports:result});
});
app.post('/api/admin/reports/:id/resolve', auth, adminOnly, (req,res) => {
  db.get('reports').find({id:parseInt(req.params.id)}).assign({resolved:true}).write();
  res.json({ok:true});
});

// ── MSG REACTIONS ─────────────────────────────────────────────
app.post('/api/messages/:id/react', auth, (req,res) => {
  const msgId=parseInt(req.params.id), me=req.session.userId;
  const {emoji} = req.body;
  const ex = db.get('msg_reactions').find({msg_id:msgId,user_id:me}).value();
  if(ex){ db.get('msg_reactions').remove({msg_id:msgId,user_id:me}).write(); res.json({removed:true}); }
  else { db.get('msg_reactions').push({msg_id:msgId,user_id:me,emoji:emoji||'❤️',created_at:Date.now()}).write(); res.json({ok:true}); }
});

// ── LOGIN HISTORY ─────────────────────────────────────────────
app.get('/api/me/login-history', auth, (req,res) => {
  const history = db.get('login_history').filter({user_id:req.session.userId}).orderBy('created_at','desc').take(20).value();
  res.json({history});
});

// ── ONLINE STATUS ─────────────────────────────────────────────
app.post('/api/me/ping', auth, (req,res) => {
  db.get('users').find({id:req.session.userId}).assign({last_seen:Date.now()}).write();
  res.json({ok:true});
});
app.get('/api/users/:username/online', auth, (req,res) => {
  const u = db.get('users').find({username:req.params.username}).value();
  if(!u) return res.json({online:false});
  const online = u.last_seen && (Date.now()-u.last_seen)<120000;
  res.json({online, last_seen:u.last_seen});
});

// ── FOLLOWERS LIST ────────────────────────────────────────────
app.get('/api/users/:username/followers', auth, (req,res) => {
  const u = db.get('users').find({username:req.params.username}).value();
  if(!u) return res.json({users:[]});
  const ids = db.get('follows').filter({following_id:u.id}).map('follower_id').value();
  res.json({users:ids.map(id=>{ const x=getUser(id); return x?{id:x.id,name:x.name,username:x.username,color:x.color,avatar:x.avatar||'',verified:x.verified||false}:null; }).filter(Boolean)});
});
app.get('/api/users/:username/following', auth, (req,res) => {
  const u = db.get('users').find({username:req.params.username}).value();
  if(!u) return res.json({users:[]});
  const ids = db.get('follows').filter({follower_id:u.id}).map('following_id').value();
  res.json({users:ids.map(id=>{ const x=getUser(id); return x?{id:x.id,name:x.name,username:x.username,color:x.color,avatar:x.avatar||'',verified:x.verified||false}:null; }).filter(Boolean)});
});

// ── 2FA (простой email-like code) ────────────────────────────
app.post('/api/me/2fa/enable', auth, (req,res) => {
  const code = Math.floor(100000+Math.random()*900000).toString();
  db.get('users').find({id:req.session.userId}).assign({twofa_code:code,twofa_enabled:true}).write();
  res.json({ok:true, code, message:'Сохрани этот код — он нужен при каждом входе'});
});
app.post('/api/me/2fa/disable', auth, (req,res) => {
  db.get('users').find({id:req.session.userId}).assign({twofa_enabled:false,twofa_code:''}).write();
  res.json({ok:true});
});

// ── MENTIONS ─────────────────────────────────────────────────
app.get('/api/mentions', auth, (req,res) => {
  const me = getUser(req.session.userId);
  if(!me) return res.json({posts:[]});
  const pattern = '@'+me.username;
  const posts = db.get('posts').filter(p=>!p.deleted&&p.text&&p.text.includes(pattern)).orderBy('created_at','desc').take(30).value();
  res.json({posts:posts.map(p=>enrichPost(p,req.session.userId))});
});

// ── QR CODE (returns URL for frontend to generate) ───────────
app.get('/api/users/:username/qr', auth, (req,res) => {
  const u = db.get('users').find({username:req.params.username}).value();
  if(!u) return res.status(404).json({error:'Нет'});
  const url = `https://vox.app/@${u.username}`;
  res.json({url, qr_url:`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`});
});


// ── CLEAR FEED (admin) ────────────────────────────────────────
app.post('/api/admin/clear-feed', auth, adminOnly, (req,res) => {
  db.get('posts').remove().write();
  db.get('likes').remove().write();
  db.get('comments').remove().write();
  db.get('reposts').remove().write();
  db.get('post_views').remove().write();
  db.get('bookmarks').remove().write();
  db.get('stories').remove().write();
  db.get('polls').remove().write();
  db.get('poll_votes').remove().write();
  // Reset post counters
  db.set('_counters.posts', 1).write();
  db.set('_counters.comments', 1).write();
  db.set('_counters.reposts', 1).write();
  db.set('_counters.stories', 1).write();
  db.set('_counters.polls', 1).write();
  res.json({ok:true});
});

// ── CAPTCHA ───────────────────────────────────────────────────
const captchas = {}; // token -> {answer, ts}

app.get('/api/captcha', (req,res) => {
  const ops = ['+','-','*'];
  const op = ops[Math.floor(Math.random()*ops.length)];
  let a = Math.floor(Math.random()*9)+1;
  let b = Math.floor(Math.random()*9)+1;
  if(op==='-') { if(a<b){let t=a;a=b;b=t;} }
  if(op==='*') { a=Math.floor(Math.random()*5)+1; b=Math.floor(Math.random()*5)+1; }
  const answer = op==='+'?a+b:op==='-'?a-b:a*b;
  const token = Math.random().toString(36).slice(2)+Date.now().toString(36);
  captchas[token] = {answer, ts:Date.now()};
  // cleanup old captchas
  Object.keys(captchas).forEach(k=>{ if(Date.now()-captchas[k].ts>300000) delete captchas[k]; });
  res.json({token, question:`${a} ${op} ${b} = ?`});
});

app.post('/api/captcha/verify', (req,res) => {
  const {token, answer} = req.body;
  const cap = captchas[token];
  if(!cap) return res.json({ok:false, error:'Капча устарела'});
  if(Date.now()-cap.ts>120000) { delete captchas[token]; return res.json({ok:false,error:'Капча устарела'}); }
  if(parseInt(answer)!==cap.answer) return res.json({ok:false,error:'Неверный ответ'});
  delete captchas[token];
  res.json({ok:true, captcha_pass:token+'_ok'});
});

// Store passed captchas in session
app.post('/api/captcha/session', (req,res) => {
  const {pass} = req.body;
  if(pass && pass.endsWith('_ok')) { req.session.captcha_ok=true; req.session.captcha_ts=Date.now(); }
  res.json({ok:!!req.session.captcha_ok});
});

app.get('/api/captcha/status', (req,res) => {
  const ok = req.session.captcha_ok && req.session.captcha_ts && (Date.now()-req.session.captcha_ts)<3600000;
  res.json({ok:!!ok});
});


app.listen(PORT,()=>console.log(`\n🚀 VOX: http://localhost:${PORT}\n`));
