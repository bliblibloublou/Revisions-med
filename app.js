/* ============================================================
   RÉVISIONS MÉDECINE v3.1
   0 donnée hardcodée · IndexedDB · Leitner · Barème EDN
   ============================================================ */

const DB_NAME = 'revisionMed_v3';
const DB_VERSION = 1;
const LEITNER_DAYS = [0, 1, 3, 7, 16];
const STATUTS = ['générée', 'à_vérifier', 'validée', 'à_corriger', 'archivée'];
const Q_TYPES = ['QCM', 'QRM', 'QRU', 'QROC', 'KFP'];
const MATIERE_COLORS = ['#0066cc','#18794e','#c98f0a','#7c3aed','#b83030','#0891b2','#db2777','#059669'];
const BACKUP_WARN_MS = 7 * 86400000;

const State = {
  matieres: [], cours: [], questions: [], history: [], config: {},
  session: null, timer: null, view: 'home'
};

let db = null;
let bannerDismissed = false;

/* ============ INDEXEDDB ============ */
function openDB(){
  return new Promise((res, rej)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e=>{
      const d = e.target.result;
      if(!d.objectStoreNames.contains('matieres')) d.createObjectStore('matieres',{keyPath:'id'});
      if(!d.objectStoreNames.contains('cours')) d.createObjectStore('cours',{keyPath:'id'});
      if(!d.objectStoreNames.contains('questions')) d.createObjectStore('questions',{keyPath:'id'});
      if(!d.objectStoreNames.contains('history')) d.createObjectStore('history',{keyPath:'id'});
      if(!d.objectStoreNames.contains('meta')) d.createObjectStore('meta',{keyPath:'key'});
    };
    req.onsuccess = e=>res(e.target.result);
    req.onerror = e=>rej(e.target.error);
  });
}
function tx(store, mode='readonly'){ return db.transaction(store, mode).objectStore(store); }
function dbAll(store){ return new Promise((res,rej)=>{const r=tx(store).getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);}); }
function dbPut(store, val){ return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(val); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);}); }
function dbDel(store, id){ return new Promise((res,rej)=>{const r=tx(store,'readwrite').delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);}); }
function dbClear(store){ return new Promise((res,rej)=>{const r=tx(store,'readwrite').clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error);}); }

/* ============ UTILS ============ */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayStr = () => new Date().toISOString().slice(0,10);
const fmtTime = s => `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`;
const shuffle = a => { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

function toast(msg, kind=''){
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 2600);
}

function openModal(html, opts={}){
  $('#modalRoot').innerHTML = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="modal-content">${opts.noClose?'':'<button class="modal-close" onclick="closeModal()">×</button>'}${html}</div></div>`;
  if(opts.onMount) opts.onMount();
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }
function confirmModal(title, msg, onConfirm, opts={}){
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="muted" style="margin-bottom:16px">${esc(msg)}</p>
    <div class="actions">
      <button class="btn btn-${opts.danger?'danger':'primary'}" id="confYes">${esc(opts.confirmLabel||'Confirmer')}</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`);
  $('#confYes').onclick = ()=>{ closeModal(); onConfirm(); };
}

/* ============ JSON SANITIZATION ============ */
function stripMarkdownFences(text){
  let t = String(text||'').trim();
  t = t.replace(/^```(?:json|JSON)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
  t = t.replace(/^\uFEFF/, '').trim();
  return t;
}
function normalizeCurlyQuotes(text){
  return text
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'");
}
function parseJSONRobust(raw){
  const cleaned = stripMarkdownFences(raw);
  try { return JSON.parse(cleaned); } catch(e1){}
  try { return JSON.parse(normalizeCurlyQuotes(cleaned)); } catch(e2){
    throw new Error('JSON invalide. Vérifie qu\'il commence par { ou [ et finit par } ou ].');
  }
}

/* ============ BUSINESS ============ */
const getMatiere = id => State.matieres.find(m=>m.id===id);
const getCours = id => State.cours.find(c=>c.id===id);
const coursOfMatiere = mid => State.cours.filter(c=>c.matiereId===mid);
const questionsOfCours = cid => State.questions.filter(q=>q.coursId===cid);
const questionsOfMatiere = mid => {
  const cids = new Set(coursOfMatiere(mid).map(c=>c.id));
  return State.questions.filter(q=>cids.has(q.coursId));
};
function isDue(q){
  if(!q.nextReview) return true;
  return new Date(q.nextReview) <= new Date();
}
function dueCount(){ return State.questions.filter(q=>isDue(q) && q.statut !== 'archivée').length; }
function applyLeitner(q, correct){
  q.attempts = (q.attempts||0) + 1;
  if(correct) q.correctAttempts = (q.correctAttempts||0) + 1;
  q.lastResult = correct;
  q.lastSeen = Date.now();
  if(correct) q.box = Math.min(4, (q.box||0) + 1);
  else q.box = 0;
  const d = LEITNER_DAYS[q.box] || 0;
  const next = new Date(Date.now() + d * 86400000);
  next.setHours(4,0,0,0);
  q.nextReview = next.toISOString();
}
function statutColor(s){
  return s==='validée'?'green':s==='à_corriger'?'red':s==='archivée'?'':'gold';
}
function statutLabel(s){ return s.replace(/_/g,' '); }
function pct(n,d){ return d ? Math.round(100*n/d) : 0; }

/* Barème EDN */
function getDiscordances(q, ans){
  if(['QROC','KFP'].includes(q.type)) return null;
  const a = Array.isArray(ans) ? ans : [];
  const key = q.ans || [];
  if(!key.length) return { discordances: 99, hit:0, wrong:a.length, missed:0 };
  const hit = a.filter(x=>key.includes(x)).length;
  const wrong = a.filter(x=>!key.includes(x)).length;
  const missed = key.filter(x=>!a.includes(x)).length;
  return { discordances: wrong + missed, hit, wrong, missed };
}
function scoreEDN(d){
  if(d===0) return 1;
  if(d===1) return 0.5;
  if(d===2) return 0.2;
  return 0;
}
function scoreQuestion(q, ans, rule){
  if(['QROC','KFP'].includes(q.type)) return null;
  if(q.type==='QRU'){
    const a = Array.isArray(ans) ? ans : [];
    const key = q.ans || [];
    if(a.length!==1 || key.length!==1) return 0;
    return a[0]===key[0] ? 1 : 0;
  }
  const d = getDiscordances(q, ans);
  if(rule==='edn') return scoreEDN(d.discordances);
  if(rule==='partial') return Math.max(0, (d.hit - d.wrong) / (q.ans?.length || 1));
  return d.discordances===0 ? 1 : 0;
}
function isLeitnerCorrect(q, ans){
  if(['QROC','KFP'].includes(q.type)) return null;
  if(q.type==='QRU'){
    const a = Array.isArray(ans) ? ans : [];
    const key = q.ans || [];
    return a.length===1 && key.length===1 && a[0]===key[0];
  }
  return getDiscordances(q, ans).discordances===0;
}

/* ============ CHARGEMENT ============ */
async function loadAll(){
  State.matieres = await dbAll('matieres');
  State.cours = await dbAll('cours');
  State.questions = await dbAll('questions');
  State.history = await dbAll('history');
  State.config = await new Promise(res=>{
    const r = tx('meta').get('config');
    r.onsuccess = ()=>res(r.result ? r.result.value : {});
    r.onerror = ()=>res({});
  });
}
async function saveConfig(){ await dbPut('meta', {key:'config', value:State.config}); }

/* ============ ROUTER ============ */
function showView(id){
  State.view = id;
  $$('.view').forEach(v=>v.classList.toggle('active', v.id===id));
  $$('.tabbar button').forEach(b=>b.classList.toggle('active', b.dataset.view===id));
  if(id==='home') renderHome();
  if(id==='train') renderTrain();
  if(id==='courses') renderCourses();
  if(id==='bank') renderBank();
  if(id==='stats') renderStats();
  if(id==='settings') renderSettings();
  renderBackupBanner();
  window.scrollTo({top:0,behavior:'smooth'});
}
$$('.tabbar button').forEach(b=>b.addEventListener('click', ()=>showView(b.dataset.view)));

/* ============ BACKUP BANNER ============ */
function renderBackupBanner(){
  const el = $('#backupBanner');
  if(!el || bannerDismissed) { if(el) el.classList.add('hidden'); return; }
  if(!State.questions.length){ el.classList.add('hidden'); return; }
  const last = State.config.lastBackupDate;
  const now = Date.now();
  const needsBackup = !last || (now - new Date(last).getTime() > BACKUP_WARN_MS);
  if(!needsBackup){ el.classList.add('hidden'); return; }
  const days = last ? Math.floor((now - new Date(last).getTime())/86400000) : null;
  const isDanger = days!==null && days>30;
  el.className = 'backup-banner' + (isDanger?' danger':'');
  el.innerHTML = `
    <span>⚠ ${last ? `Dernière sauvegarde il y a ${days} jour${days>1?'s':''}` : 'Aucune sauvegarde enregistrée'}</span>
    <div style="display:flex;gap:6px">
      <button onclick="exportBackup()">Exporter maintenant</button>
      <button class="dismiss" onclick="dismissBanner()" title="Masquer">×</button>
    </div>`;
}
function dismissBanner(){ bannerDismissed = true; $('#backupBanner').classList.add('hidden'); }
async function updateBackupDate(){
  State.config.lastBackupDate = new Date().toISOString();
  await saveConfig();
  renderBackupBanner();
}

/* ============ VUE ACCUEIL ============ */
function renderHome(){
  const root = $('#home');
  const total = State.questions.length;
  const due = dueCount();
  const mistakes = State.questions.filter(q=>q.lastResult===false).length;

  if(total===0 && State.cours.length===0){
    root.innerHTML = renderOnboarding();
    return;
  }

  let heroHTML;
  if(due>0){
    heroHTML = `<div class="hero">
      <div class="eyebrow" style="color:var(--gold)">Révisions du jour</div>
      <h2>${due} question${due>1?'s':''} à revoir</h2>
      <p>Ton programme de révision espacée est prêt.</p>
      <div class="actions">
        <button class="btn btn-primary" onclick="startReview()">Réviser maintenant</button>
        <button class="btn btn-outline" onclick="showView('train')">Configurer une séance</button>
      </div></div>`;
  } else {
    heroHTML = `<div class="hero">
      <div class="eyebrow" style="color:var(--gold)">Programme à jour</div>
      <h2>Rien à réviser aujourd'hui</h2>
      <p>Tu peux avancer sur un nouveau cours ou tester un examen blanc.</p>
      <div class="actions">
        <button class="btn btn-primary" onclick="showView('courses')">Voir mes cours</button>
        <button class="btn btn-outline" onclick="showView('train')">Lancer une séance</button>
      </div></div>`;
  }

  const statsHTML = `<div class="stats">
    <div class="stat blue"><div class="num">${total}</div><div class="lbl">Questions</div></div>
    <div class="stat gold"><div class="num">${due}</div><div class="lbl">À réviser</div></div>
    <div class="stat"><div class="num">${State.history.length}</div><div class="lbl">Séances</div></div>
    <div class="stat danger"><div class="num">${mistakes}</div><div class="lbl">Erreurs</div></div>
  </div>`;

  const coursList = State.cours.map(c=>{
    const qs = questionsOfCours(c.id);
    const due = qs.filter(isDue).length;
    const attempts = qs.reduce((n,q)=>n+(q.attempts||0),0);
    const correct = qs.reduce((n,q)=>n+(q.correctAttempts||0),0);
    return {c, n:qs.length, due, pct: pct(correct, attempts)};
  }).filter(x=>x.n>0).sort((a,b)=>b.n-a.n).slice(0,6);

  const coursHTML = coursList.length ? coursList.map(({c,n,due,pct:p})=>{
    const m = getMatiere(c.matiereId);
    return `<div class="list-row">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;margin-bottom:2px">${esc(c.nom)}</div>
        <div class="small">${esc(m?.nom||'—')} · ${n} Q${due?' · '+due+' à revoir':''}</div>
      </div>
      <div style="width:80px"><div class="bar ${p>=70?'green':p>=40?'gold':''}"><span style="width:${p}%"></span></div></div>
      <button class="btn btn-light btn-sm" onclick="quickTrain('${c.id}')">Réviser</button>
    </div>`;
  }).join('') : '<div class="empty" style="padding:20px"><p>Crée un cours et ajoute des questions.</p></div>';

  root.innerHTML = `${heroHTML}${statsHTML}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="font-size:15px">Mes cours</h3>
        <button class="btn btn-outline btn-sm" onclick="showView('courses')">Tout voir</button>
      </div>
      <div class="list">${coursHTML}</div>
    </div>`;
}

function renderOnboarding(){
  return `<div class="hero" style="text-align:center;padding:40px 24px">
    <div class="eyebrow" style="color:var(--gold)">Bienvenue</div>
    <h2 style="margin-bottom:12px">Commence par créer ton premier cours</h2>
    <p style="margin:0 auto 20px;max-width:480px">L'application ne contient aucune donnée. Tu importes tes propres questions générées à partir de tes cours, ou tu en crées manuellement.</p>
    <div class="actions" style="justify-content:center">
      <button class="btn btn-primary" onclick="openNewMatiere()">Créer une matière</button>
      <button class="btn btn-outline" onclick="showView('settings')">Importer un fichier</button>
    </div>
  </div>
  <div class="card">
    <h3 style="font-size:15px;margin-bottom:12px">Comment ça marche</h3>
    <ol style="padding-left:20px;line-height:1.8;font-size:14px;color:var(--muted);margin:0">
      <li><b style="color:var(--ink)">Crée une matière</b> (ex : Neurologie)</li>
      <li><b style="color:var(--ink)">Crée un cours</b> dans cette matière (ex : Moelle spinale)</li>
      <li><b style="color:var(--ink)">Génère un JSON</b> avec ChatGPT à partir de ton PDF (prompt dans Réglages)</li>
      <li><b style="color:var(--ink)">Importe</b> le JSON — les questions sont rattachées au cours</li>
      <li><b style="color:var(--ink)">Révise</b> et suis ta progression par cours</li>
    </ol>
  </div>`;
}

/* ============ CRUD MATIÈRES ============ */
function openNewMatiere(){
  openModal(`
    <h3>Nouvelle matière</h3>
    <p class="modal-sub">Ex : Neurologie, Cardiologie, Pneumologie…</p>
    <label class="field">Nom</label>
    <input type="text" id="newMatNom" placeholder="Ex : Neurologie" autofocus>
    <label class="field">Couleur</label>
    <div id="colorPicker" style="display:flex;gap:8px;flex-wrap:wrap">
      ${MATIERE_COLORS.map((c,i)=>`<button data-c="${c}" style="width:32px;height:32px;border-radius:50%;background:${c};border:3px solid ${i===0?'#0d2f55':'transparent'}" onclick="selectColor(this)"></button>`).join('')}
    </div>
    <div class="actions">
      <button class="btn btn-primary" id="btnCreateMat">Créer</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`);
  $('#btnCreateMat').onclick = async ()=>{
    const nom = $('#newMatNom').value.trim();
    if(!nom){ toast('Nom requis','error'); return; }
    const selected = document.querySelector('[data-c]');
    const btn = [...document.querySelectorAll('[data-c]')].find(b=>b.style.borderColor.includes('13, 47, 85')||b.style.borderColor.includes('rgb(13, 47, 85)'));
    const couleur = btn ? btn.dataset.c : MATIERE_COLORS[0];
    const m = { id: uid(), nom, couleur, createdAt: Date.now() };
    await dbPut('matieres', m);
    State.matieres.push(m);
    closeModal();
    toast('Matière créée','success');
    renderCourses();
  };
  $('#newMatNom').addEventListener('keydown', e=>{ if(e.key==='Enter') $('#btnCreateMat').click(); });
}
function selectColor(btn){
  document.querySelectorAll('[data-c]').forEach(b=>b.style.borderColor='transparent');
  btn.style.borderColor = '#0d2f55';
}
function openEditMatiere(id){
  const m = getMatiere(id);
  if(!m) return;
  openModal(`
    <h3>Renommer la matière</h3>
    <label class="field">Nom</label>
    <input type="text" id="editMatNom" value="${esc(m.nom)}" autofocus>
    <div class="actions">
      <button class="btn btn-primary" id="btnSaveMat">Enregistrer</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`);
  $('#btnSaveMat').onclick = async ()=>{
    const nom = $('#editMatNom').value.trim();
    if(!nom){ toast('Nom requis','error'); return; }
    m.nom = nom; await dbPut('matieres', m);
    closeModal(); toast('Modifié','success'); renderCourses();
  };
}
function deleteMatiere(id){
  const m = getMatiere(id);
  const cs = coursOfMatiere(id);
  const nQ = questionsOfMatiere(id).length;
  confirmModal('Supprimer la matière ?',
    `"${m.nom}" sera supprimée avec ${cs.length} cours et ${nQ} questions. Action irréversible.`,
    async ()=>{
      for(const c of cs) await dbDel('cours', c.id);
      for(const q of questionsOfMatiere(id)) await dbDel('questions', q.id);
      await dbDel('matieres', id);
      await loadAll(); toast('Supprimée','success'); renderCourses();
    }, {danger:true, confirmLabel:'Supprimer définitivement'});
}

/* ============ CRUD COURS ============ */
function openNewCours(matiereId){
  const m = getMatiere(matiereId);
  if(!m) return;
  openModal(`
    <h3>Nouveau cours</h3>
    <p class="modal-sub">Dans ${esc(m.nom)}</p>
    <label class="field">Nom du cours</label>
    <input type="text" id="newCoursNom" placeholder="Ex : Moelle spinale" autofocus>
    <div class="actions">
      <button class="btn btn-primary" id="btnCreateCours">Créer</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`);
  $('#btnCreateCours').onclick = async ()=>{
    const nom = $('#newCoursNom').value.trim();
    if(!nom){ toast('Nom requis','error'); return; }
    const c = { id: uid(), matiereId, nom, createdAt: Date.now() };
    await dbPut('cours', c);
    State.cours.push(c);
    closeModal(); toast('Cours créé','success'); renderCourses();
  };
  $('#newCoursNom').addEventListener('keydown', e=>{ if(e.key==='Enter') $('#btnCreateCours').click(); });
}
function openEditCours(id){
  const c = getCours(id);
  if(!c) return;
  openModal(`
    <h3>Renommer le cours</h3>
    <label class="field">Nom</label>
    <input type="text" id="editCoursNom" value="${esc(c.nom)}" autofocus>
    <div class="actions">
      <button class="btn btn-primary" id="btnSaveCours">Enregistrer</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`);
  $('#btnSaveCours').onclick = async ()=>{
    const nom = $('#editCoursNom').value.trim();
    if(!nom){ toast('Nom requis','error'); return; }
    c.nom = nom; await dbPut('cours', c);
    closeModal(); toast('Modifié','success'); renderCourses();
  };
}
function deleteCours(id){
  const c = getCours(id);
  const qs = questionsOfCours(id);
  confirmModal('Supprimer le cours ?',
    `"${c.nom}" sera supprimé avec ${qs.length} question(s).`,
    async ()=>{
      for(const q of qs) await dbDel('questions', q.id);
      await dbDel('cours', id);
      await loadAll(); toast('Supprimé','success'); renderCourses();
    }, {danger:true, confirmLabel:'Supprimer'});
}

/* ============ VUE COURS ============ */
function renderCourses(){
  const root = $('#courses');
  const matieresHTML = State.matieres.length ? State.matieres.map(m=>{
    const cs = coursOfMatiere(m.id);
    const totalQ = questionsOfMatiere(m.id).length;
    const coursRows = cs.length ? cs.map(c=>{
      const qs = questionsOfCours(c.id);
      const due = qs.filter(isDue).length;
      const attempts = qs.reduce((n,q)=>n+(q.attempts||0),0);
      const correct = qs.reduce((n,q)=>n+(q.correctAttempts||0),0);
      const p = pct(correct, attempts);
      return `<div class="cours-row">
        <div class="cours-info">
          <b>${esc(c.nom)}</b>
          <div class="mini-stats">${qs.length} question${qs.length!==1?'s':''}${due?' · '+due+' à revoir':''}${attempts?' · '+p+'% réussite':''}</div>
        </div>
        <div class="cours-progress">
          <div class="pct">${qs.length?p+'%':'—'}</div>
          <div class="bar ${p>=70?'green':p>=40?'gold':''}"><span style="width:${p}%"></span></div>
        </div>
        <div class="cours-actions">
          <button class="btn btn-primary btn-sm" onclick="quickTrain('${c.id}')" ${qs.length?'':'disabled'}>Réviser</button>
          <button class="btn btn-outline btn-sm" onclick="openEditCours('${c.id}')" title="Renommer">✎</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCours('${c.id}')" title="Supprimer">🗑</button>
        </div>
      </div>`;
    }).join('') : `<div style="padding:14px 0;color:var(--muted);font-size:13px">Aucun cours. <button class="btn btn-light btn-sm" onclick="openNewCours('${m.id}')" style="margin-left:6px">+ Créer</button></div>`;

    return `<div class="matiere-block">
      <div class="matiere-header">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="width:6px;height:38px;border-radius:3px;background:${esc(m.couleur||'#0066cc')}"></div>
          <div>
            <h3>${esc(m.nom)}</h3>
            <div class="meta">${cs.length} cours · ${totalQ} question${totalQ!==1?'s':''}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-light btn-sm" onclick="openNewCours('${m.id}')">+ Cours</button>
          <button class="btn btn-outline btn-sm" onclick="openEditMatiere('${m.id}')">Renommer</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMatiere('${m.id}')">Suppr.</button>
        </div>
      </div>
      <div class="cours-list">${coursRows}</div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">📚</div><h3>Aucune matière</h3><p>Commence par créer une matière (ex : Neurologie)</p><button class="btn btn-primary" onclick="openNewMatiere()">Créer une matière</button></div>`;

  root.innerHTML = `
    <div class="page-title">Mes cours</div>
    <div class="page-sub">Organise ton programme par matière et cours</div>
    <div class="actions" style="margin-bottom:16px">
      <button class="btn btn-primary" onclick="openNewMatiere()">+ Nouvelle matière</button>
    </div>
    ${matieresHTML}`;
}

/* ============ TRAIN VIEW ============ */
function renderTrain(){
  const root = $('#train');
  const matieresOpts = State.matieres.map(m=>`<option value="${m.id}">${esc(m.nom)}</option>`).join('');
  root.innerHTML = `
    <div class="page-title">Entraînement</div>
    <div class="page-sub">Configure une séance</div>
    <div class="card">
      <div class="form-grid">
        <div><label class="field">Mode</label><select id="cfgMode">
          <option value="training">Apprentissage</option>
          <option value="exam">Examen blanc</option>
          <option value="review">Révision espacée</option>
        </select></div>
        <div><label class="field">Matière</label><select id="cfgMatiere"><option value="">Toutes</option>${matieresOpts}</select></div>
        <div><label class="field">Cours</label><select id="cfgCours"><option value="">Tous</option></select></div>
        <div><label class="field">Type</label><select id="cfgType">
          <option value="">Tous</option>
          <option value="qcm">QCM / QRM / QRU</option>
          <option value="qroc">QROC / KFP</option>
        </select></div>
        <div><label class="field">Nombre</label><select id="cfgCount">
          <option>10</option><option selected>20</option><option>30</option><option>40</option><option>60</option><option value="all">Toutes</option>
        </select></div>
        <div><label class="field">Durée (min, 0 = libre)</label><input type="number" id="cfgMinutes" min="0" max="240" value="30"></div>
        <div><label class="field">Barème QCM</label><select id="cfgScore">
          <option value="edn" selected>Barème EDN (discordances)</option>
          <option value="exact">Tout ou rien</option>
          <option value="partial">Partiel simple</option>
        </select></div>
        <div><label class="field">Statut</label><select id="cfgStatut">
          <option value="">Tous</option>
          <option value="validée">Validées uniquement</option>
          <option value="non_validée">Non validées</option>
        </select></div>
      </div>
      <div style="margin-top:14px">
        <label class="checkboxline"><input type="checkbox" id="cfgOnlyMistakes"> Uniquement mes erreurs</label>
        <label class="checkboxline"><input type="checkbox" id="cfgShuffle" checked> Mélanger</label>
      </div>
      <div class="actions"><button class="btn btn-primary" onclick="startSessionFromUI()">Commencer</button></div>
    </div>
    <div id="sessionArea"></div>`;
  $('#cfgMatiere').addEventListener('change', ()=>{
    const mid = $('#cfgMatiere').value;
    const cs = mid ? coursOfMatiere(mid) : State.cours;
    $('#cfgCours').innerHTML = '<option value="">Tous</option>' + cs.map(c=>`<option value="${c.id}">${esc(c.nom)}</option>`).join('');
  });
}
function startSessionFromUI(){
  launchSession({
    matiereId: $('#cfgMatiere').value || null,
    coursId: $('#cfgCours').value || null,
    type: $('#cfgType').value,
    countVal: $('#cfgCount').value,
    minutes: Number($('#cfgMinutes').value)||0,
    scoreRule: $('#cfgScore').value,
    statut: $('#cfgStatut').value,
    onlyMistakes: $('#cfgOnlyMistakes').checked,
    doShuffle: $('#cfgShuffle').checked,
    mode: $('#cfgMode').value
  });
}
function quickTrain(coursId){
  const qs = questionsOfCours(coursId);
  if(!qs.length){ toast('Ce cours n\'a pas encore de questions','error'); return; }
  launchSession({ coursId, mode:'training', countVal: qs.length, minutes:0, scoreRule:'edn', onlyMistakes:false, doShuffle:false });
}
function startReview(){
  const due = State.questions.filter(q=>isDue(q) && q.statut !== 'archivée');
  if(!due.length){ toast('Rien à réviser','info'); return; }
  launchSession({ mode:'training', countVal: due.length, minutes:0, scoreRule:'edn', onlyMistakes:false, doShuffle:false, onlyDue:true, questionsOverride:due });
}

function launchSession(cfg){
  if(State.timer){ clearInterval(State.timer); State.timer=null; }
  let qs = cfg.questionsOverride ? cfg.questionsOverride.slice() : State.questions.slice();
  if(!cfg.questionsOverride){
    if(cfg.coursId) qs = qs.filter(q=>q.coursId === cfg.coursId);
    else if(cfg.matiereId){
      const cids = new Set(coursOfMatiere(cfg.matiereId).map(c=>c.id));
      qs = qs.filter(q=>cids.has(q.coursId));
    }
    if(cfg.type==='qcm') qs = qs.filter(q=>['QCM','QRM','QRU'].includes(q.type));
    if(cfg.type==='qroc') qs = qs.filter(q=>['QROC','KFP'].includes(q.type));
    if(cfg.statut==='validée') qs = qs.filter(q=>q.statut==='validée');
    if(cfg.statut==='non_validée') qs = qs.filter(q=>q.statut!=='validée' && q.statut!=='archivée');
    else qs = qs.filter(q=>q.statut!=='archivée');
    if(cfg.onlyMistakes) qs = qs.filter(q=>q.lastResult===false);
    if(cfg.onlyDue) qs = qs.filter(isDue);
    if(cfg.mode==='review') qs = qs.filter(isDue);
    if(cfg.doShuffle) shuffle(qs);
  }
  const count = cfg.countVal==='all' ? qs.length : Number(cfg.countVal);
  qs = qs.slice(0, count);
  if(!qs.length){ toast('Aucune question ne correspond','error'); return; }
  State.session = {
    mode: cfg.mode, questions: qs, answers: {}, revealed: {}, submitted: {},
    index: 0, started: Date.now(),
    remaining: (cfg.minutes||0)*60,
    scoreRule: cfg.scoreRule, finished: false, config: cfg
  };
  showView('train');
  renderSession();
  if(cfg.mode==='exam' && State.session.remaining>0){
    State.timer = setInterval(()=>{
      if(!State.session || State.session.finished) return;
      State.session.remaining--;
      const t = $('#timer');
      if(t) t.textContent = fmtTime(State.session.remaining);
      if(State.session.remaining<=0){ clearInterval(State.timer); State.timer=null; finishSession(true); }
    }, 1000);
  }
  setTimeout(()=>$('#sessionArea')?.scrollIntoView({behavior:'smooth',block:'start'}), 100);
}

/* ============ SESSION RENDERING ============ */
function renderSession(){
  const root = $('#sessionArea');
  if(!State.session){ root.innerHTML=''; return; }
  if(State.session.finished){ renderResults(); return; }
  const s = State.session;
  const q = s.questions[s.index];
  const idx = s.index;
  const answered = Object.keys(s.answers).length;
  const modeLabel = { training:'Apprentissage', exam:'Examen blanc', review:'Révision espacée' }[s.mode];
  const cours = getCours(q.coursId);
  const matiere = cours ? getMatiere(cours.matiereId) : null;

  let html = `<div class="session-bar">
    <div>
      <b style="font-size:13px">${modeLabel}</b>
      <div class="small">Question ${idx+1}/${s.questions.length} · ${answered} réponse${answered>1?'s':''}</div>
    </div>
    <div class="timer" id="timer">${s.mode==='exam'&&s.remaining>0 ? fmtTime(s.remaining) : '∞'}</div>
    <button class="btn btn-outline btn-sm" onclick="quitSession()">Quitter</button>
    <div class="session-hint">A-E : cocher · ⏎ : valider/suivant · ←→ : naviguer</div>
  </div>
  <div class="progress"><span style="width:${100*idx/s.questions.length}%"></span></div>
  <div class="q-card">
    <div class="q-meta">
      <span class="pill blue">${esc(q.type)}</span>
      ${matiere?`<span class="pill">${esc(matiere.nom)}</span>`:''}
      ${cours?`<span class="pill">${esc(cours.nom)}</span>`:''}
      ${q.section?`<span class="pill">${esc(q.section)}</span>`:''}
      <span class="pill gold">Box ${(q.box||0)+1}</span>
      <span class="pill">${esc(q.difficulty||'Standard')}</span>
    </div>
    <div class="q-stem">${esc(q.stem)}</div>
    ${q.image?`<img src="${q.image}" class="img-q" alt="">`:''}
    ${renderAnswerInputs(q, s)}
    ${s.revealed[q.id] && s.mode!=='exam' ? renderFeedback(q, s) : ''}
  </div>
  <div class="actions">
    ${idx>0?`<button class="btn btn-light" onclick="prevQ()">← Précédente</button>`:''}
    ${s.mode!=='exam' && !s.revealed[q.id] ? `<button class="btn btn-primary" onclick="revealAnswer()">Vérifier</button>` : ''}
    ${idx<s.questions.length-1
      ? `<button class="btn btn-primary" onclick="nextQ()">Suivante →</button>`
      : `<button class="btn btn-primary" onclick="finishSession(false)">Terminer la séance</button>`}
  </div>
  ${s.mode==='exam' ? '<p class="small" style="margin-top:10px">Corrections masquées jusqu\'à la fin.</p>' : ''}`;

  root.innerHTML = html;
  bindAnswerInputs(q);
}

function renderAnswerInputs(q, s){
  const isShort = ['QROC','KFP'].includes(q.type);
  if(isShort) return `<textarea id="answer_${q.id}" placeholder="Rédige ta réponse…" style="min-height:120px">${esc(s.answers[q.id]||'')}</textarea>`;
  const picked = s.answers[q.id] || [];
  const single = q.type==='QRU';
  return q.opts.map((opt,i)=>{
    const letter = String.fromCharCode(65+i);
    return `<label class="q-opt"><input type="${single?'radio':'checkbox'}" name="ans_${q.id}" value="${i}" ${picked.includes(i)?'checked':''}><span class="letter">${letter}.</span><span>${esc(opt)}</span></label>`;
  }).join('');
}

function bindAnswerInputs(q){
  const s = State.session;
  const sel = `[name="ans_${CSS.escape(q.id)}"]`;
  $$(sel).forEach(el=>{
    el.addEventListener('change', ()=>{
      if(q.type==='QRU'){
        const c = document.querySelector(`${sel}:checked`);
        s.answers[q.id] = c ? [Number(c.value)] : [];
      } else {
        s.answers[q.id] = [...document.querySelectorAll(`${sel}:checked`)].map(x=>Number(x.value));
      }
    });
  });
  const ta = document.getElementById('answer_'+q.id);
  if(ta) ta.addEventListener('input', ()=> s.answers[q.id] = ta.value);
}

function saveAnswer(){
  if(!State.session) return;
  const s = State.session;
  const q = s.questions[s.index];
  const ta = document.getElementById('answer_'+q.id);
  if(ta){ s.answers[q.id] = ta.value; return; }
  const sel = `[name="ans_${CSS.escape(q.id)}"]`;
  s.answers[q.id] = [...document.querySelectorAll(`${sel}:checked`)].map(x=>Number(x.value));
}

function renderFeedback(q, s){
  if(['QROC','KFP'].includes(q.type)){
    return `<div class="feedback"><h4>Éléments attendus</h4><p>${esc(q.expected||q.exp||'Non renseigné')}</p><p class="small">Auto-évaluation.</p></div>`;
  }
  if(q.type==='QRU'){
    const sc = scoreQuestion(q, s.answers[q.id], s.scoreRule);
    const ok = sc>=1;
    return `<div class="feedback ${ok?'good':'bad'}">
      <h4>${ok?'✓ Correct':'✕ À revoir'}</h4>
      <p><b>Réponse attendue :</b> ${esc((q.ans||[]).map(i=>String.fromCharCode(65+i)).join(', ')||'—')}</p>
      <p>${esc(q.exp||'')}</p>
      ${q.source?`<p class="source">Source : ${esc(q.source)}</p>`:''}
    </div>`;
  }
  const d = getDiscordances(q, s.answers[q.id]);
  const sc = scoreQuestion(q, s.answers[q.id], s.scoreRule);
  const cls = d.discordances===0 ? 'good' : (sc>0 ? 'partial' : 'bad');
  const label = d.discordances===0 ? '✓ Correct' : `${d.discordances} discordance${d.discordances>1?'s':''} — ${Math.round(sc*100)}%`;
  const ans = (q.ans||[]).map(i=>String.fromCharCode(65+i)).join(', ');
  return `<div class="feedback ${cls}">
    <h4>${label}</h4>
    <p><b>Réponse attendue :</b> ${esc(ans||'—')}</p>
    <p>${esc(q.exp||'')}</p>
    ${q.source?`<p class="source">Source : ${esc(q.source)}</p>`:''}
  </div>`;
}

function revealAnswer(){
  saveAnswer();
  const s = State.session;
  const q = s.questions[s.index];
  if(s.submitted[q.id]) return;
  const leitnerOk = isLeitnerCorrect(q, s.answers[q.id]);
  if(leitnerOk !== null){
    applyLeitner(q, leitnerOk);
    dbPut('questions', q);
  } else {
    q.attempts = (q.attempts||0) + 1;
    q.lastSeen = Date.now();
    dbPut('questions', q);
  }
  s.submitted[q.id] = true;
  s.revealed[q.id] = true;
  renderSession();
}
function nextQ(){ if(!State.session) return; saveAnswer(); State.session.index++; renderSession(); window.scrollTo({top:0,behavior:'smooth'}); }
function prevQ(){ if(!State.session) return; saveAnswer(); State.session.index--; renderSession(); window.scrollTo({top:0,behavior:'smooth'}); }

function quitSession(){
  confirmModal('Quitter la séance ?', 'La progression non terminée ne sera pas enregistrée.',
    ()=>{ if(State.timer) clearInterval(State.timer); State.timer=null; State.session=null; $('#sessionArea').innerHTML=''; },
    {danger:true, confirmLabel:'Quitter'});
}

function finishSession(timeUp=false){
  const s = State.session;
  if(!s || s.finished) return;
  saveAnswer();
  s.finished = true;
  if(State.timer){ clearInterval(State.timer); State.timer=null; }
  let qcmTotal=0, qcmCorrect=0, qcmScoreSum=0;
  s.questions.forEach(q=>{
    if(['QROC','KFP'].includes(q.type)) return;
    qcmTotal++;
    if(!s.submitted[q.id]){
      const lkOk = isLeitnerCorrect(q, s.answers[q.id]);
      applyLeitner(q, lkOk===true);
      s.submitted[q.id] = true;
      dbPut('questions', q);
    }
    const sc = scoreQuestion(q, s.answers[q.id], s.scoreRule) || 0;
    if(sc>=0.99) qcmCorrect++;
    qcmScoreSum += sc;
  });
  const record = {
    id: uid(),
    date: new Date().toISOString(),
    mode: s.mode,
    coursId: s.config.coursId || null,
    matiereId: s.config.matiereId || null,
    total: s.questions.length,
    qcmTotal, qcmCorrect,
    score: qcmTotal ? Math.round(100*qcmScoreSum/qcmTotal) : null,
    scoreExact: qcmTotal ? Math.round(100*qcmCorrect/qcmTotal) : null,
    scoreRule: s.scoreRule,
    timeSeconds: Math.round((Date.now()-s.started)/1000),
    timeUp
  };
  State.history.unshift(record);
  dbPut('history', record);
  renderResults();
}

function renderResults(){
  const s = State.session;
  const root = $('#sessionArea');
  const qcm = s.questions.filter(q=>!['QROC','KFP'].includes(q.type));
  const exactCorrect = qcm.filter(q=>{
    const d = getDiscordances(q, s.answers[q.id]);
    return d && d.discordances===0;
  }).length;
  const weighted = qcm.reduce((n,q)=>n+(scoreQuestion(q, s.answers[q.id], s.scoreRule)||0), 0);
  const pExact = qcm.length ? Math.round(100*exactCorrect/qcm.length) : null;
  const pWeighted = qcm.length ? Math.round(100*weighted/qcm.length) : null;

  let html = `<div class="card" style="text-align:center;padding:32px 20px">
    <div class="eyebrow" style="color:var(--gold)">Séance terminée</div>
    <div style="font-size:56px;font-weight:900;letter-spacing:-.04em;color:${pWeighted>=70?'var(--success)':pWeighted>=40?'var(--gold)':'var(--danger)'};line-height:1;margin:10px 0">${pWeighted!==null?pWeighted+'%':'—'}</div>
    <p class="muted" style="font-size:13px">Score pondéré — barème ${s.scoreRule==='edn'?'EDN':s.scoreRule==='partial'?'partiel':'tout ou rien'}</p>
    ${pExact!==null?`<p class="small" style="margin-top:6px">Sans faute : ${exactCorrect}/${qcm.length} · ${pExact}% · ${s.questions.length-qcm.length} question(s) rédigée(s)</p>`:''}
    <div class="actions" style="justify-content:center">
      <button class="btn btn-primary" onclick="showView('home')">Accueil</button>
      <button class="btn btn-light" onclick="showView('train');State.session=null;$('#sessionArea').innerHTML=''">Nouvelle séance</button>
    </div>
  </div>`;

  s.questions.forEach((q,i)=>{
    const isShort = ['QROC','KFP'].includes(q.type);
    const d = getDiscordances(q, s.answers[q.id]);
    const sc = isShort ? null : scoreQuestion(q, s.answers[q.id], s.scoreRule);
    const ok = sc===null ? null : sc>=0.99;
    const partial = sc!==null && sc>0 && sc<0.99;
    const cours = getCours(q.coursId);
    const discLabel = d && !isShort ? (d.discordances===0?'0 discordance':`${d.discordances} discordance${d.discordances>1?'s':''}`) : '';
    const scoreLabel = sc!==null ? ` · ${Math.round(sc*100)}%` : '';

    html += `<div class="q-card">
      <div class="q-meta">
        <span class="pill blue">${esc(q.type)}</span>
        ${cours?`<span class="pill">${esc(cours.nom)}</span>`:''}
        <span class="pill ${ok?'green':partial?'gold':'red'}">${ok?'✓':partial?'◐':'✕'} ${discLabel}${scoreLabel}</span>
        <span class="pill ${statutColor(q.statut)}">${esc(statutLabel(q.statut))}</span>
      </div>
      <div class="q-stem">${i+1}. ${esc(q.stem)}</div>
      ${isShort
        ? `<p><b>Ta réponse :</b> ${esc(s.answers[q.id]||'—')}</p><div class="feedback"><b>Attendu :</b> ${esc(q.expected||q.exp||'—')}</div>`
        : `<p><b>Ta réponse :</b> ${esc((s.answers[q.id]||[]).map(n=>String.fromCharCode(65+n)).join(', ')||'—')}</p>
           <p><b>Attendu :</b> ${esc((q.ans||[]).map(n=>String.fromCharCode(65+n)).join(', '))}</p>
           <div class="feedback ${ok?'good':partial?'partial':'bad'}">${esc(q.exp||'')}</div>
           ${q.source?`<p class="source">Source : ${esc(q.source)}</p>`:''}`}
      <div class="actions" style="margin-top:10px">
        ${q.statut!=='validée'?`<button class="btn btn-success btn-sm" onclick="validateQuestionInline('${q.id}')">✓ Valider</button>`:'<span class="pill green">Validée</span>'}
        <button class="btn btn-outline btn-sm" onclick="openEditQuestion('${q.id}')">✎ Modifier</button>
        <button class="btn btn-danger btn-sm" onclick="deleteQuestionInline('${q.id}')">🗑 Supprimer</button>
      </div>
    </div>`;
  });
  root.innerHTML = html;
  window.scrollTo({top:0,behavior:'smooth'});
}

async function validateQuestionInline(id){
  const q = State.questions.find(x=>x.id===id);
  if(!q) return;
  q.statut = 'validée';
  await dbPut('questions', q);
  toast('Question validée','success');
  renderResults();
}
function deleteQuestionInline(id){
  confirmModal('Supprimer cette question ?','Elle sera retirée définitivement.',
    async ()=>{
      await dbDel('questions', id);
      State.questions = State.questions.filter(q=>q.id!==id);
      if(State.session) State.session.questions = State.session.questions.filter(q=>q.id!==id);
      toast('Supprimée','success');
      renderResults();
    }, {danger:true, confirmLabel:'Supprimer'});
}

/* ============ BANQUE ============ */
function renderBank(){
  const root = $('#bank');
  const matOpts = State.matieres.map(m=>`<option value="${m.id}">${esc(m.nom)}</option>`).join('');
  root.innerHTML = `
    <div class="page-title">Banque de questions</div>
    <div class="page-sub">${State.questions.length} question${State.questions.length!==1?'s':''} au total</div>
    <div class="card">
      <div class="form-grid-3">
        <div><label class="field">Rechercher</label><input type="text" id="bankSearch" placeholder="Mot-clé…"></div>
        <div><label class="field">Matière</label><select id="bankMat"><option value="">Toutes</option>${matOpts}</select></div>
        <div><label class="field">Cours</label><select id="bankCours"><option value="">Tous</option></select></div>
        <div><label class="field">Type</label><select id="bankType"><option value="">Tous</option>${Q_TYPES.map(t=>`<option value="${t}">${t}</option>`).join('')}</select></div>
        <div><label class="field">Statut</label><select id="bankStatut"><option value="">Tous</option>${STATUTS.map(s=>`<option value="${s}">${statutLabel(s)}</option>`).join('')}</select></div>
        <div style="display:flex;align-items:flex-end"><button class="btn btn-primary btn-block" onclick="openNewQuestion()">+ Nouvelle question</button></div>
      </div>
    </div>
    <div id="bankList"></div>`;
  $('#bankMat').addEventListener('change', ()=>{
    const mid = $('#bankMat').value;
    const cs = mid ? coursOfMatiere(mid) : State.cours;
    $('#bankCours').innerHTML = '<option value="">Tous</option>' + cs.map(c=>`<option value="${c.id}">${esc(c.nom)}</option>`).join('');
    renderBankList();
  });
  $('#bankSearch').addEventListener('input', renderBankList);
  $('#bankCours').addEventListener('change', renderBankList);
  $('#bankType').addEventListener('change', renderBankList);
  $('#bankStatut').addEventListener('change', renderBankList);
  renderBankList();
}

function renderBankList(){
  const search = ($('#bankSearch')?.value||'').toLowerCase();
  const mid = $('#bankMat')?.value||'';
  const cid = $('#bankCours')?.value||'';
  const type = $('#bankType')?.value||'';
  const statut = $('#bankStatut')?.value||'';
  let qs = State.questions.filter(q=>{
    if(cid && q.coursId!==cid) return false;
    if(mid){
      const c = getCours(q.coursId);
      if(!c || c.matiereId!==mid) return false;
    }
    if(type && q.type!==type) return false;
    if(statut && q.statut!==statut) return false;
    if(search){
      const hay = [q.stem, q.exp, q.expected, ...(q.opts||[]), q.section||''].join(' ').toLowerCase();
      if(!hay.includes(search)) return false;
    }
    return true;
  });
  const root = $('#bankList');
  if(!qs.length){
    root.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>Aucune question trouvée</h3><p>Modifie les filtres ou ajoute des questions.</p></div>`;
    return;
  }
  root.innerHTML = qs.map(q=>{
    const cours = getCours(q.coursId);
    const matiere = cours ? getMatiere(cours.matiereId) : null;
    const sc = q.attempts ? Math.round(100*q.correctAttempts/q.attempts) : null;
    return `<div class="q-card">
      <div class="q-meta">
        <span class="pill blue">${esc(q.type)}</span>
        ${matiere?`<span class="pill">${esc(matiere.nom)}</span>`:''}
        ${cours?`<span class="pill">${esc(cours.nom)}</span>`:''}
        ${q.section?`<span class="pill">${esc(q.section)}</span>`:''}
        <span class="pill ${statutColor(q.statut)}">${esc(statutLabel(q.statut))}</span>
        <span class="pill">Box ${(q.box||0)+1}</span>
        ${q.lastResult===false?'<span class="pill red">À revoir</span>':''}
      </div>
      <div class="q-stem">${esc(q.stem)}</div>
      <p class="small">${q.opts.length?q.opts.length+' propositions · ':''}${q.attempts||0} tentative${(q.attempts||0)!==1?'s':''}${sc!==null?' · '+sc+'% réussite':''}</p>
      <div class="actions">
        <button class="btn btn-primary btn-sm" onclick="singleTrain('${q.id}')">S'entraîner</button>
        <button class="btn btn-outline btn-sm" onclick="openEditQuestion('${q.id}')">Modifier</button>
        <button class="btn btn-light btn-sm" onclick="cycleStatut('${q.id}')">Statut</button>
        <button class="btn btn-danger btn-sm" onclick="deleteQuestion('${q.id}')">Suppr.</button>
      </div>
    </div>`;
  }).join('');
}
async function cycleStatut(id){
  const q = State.questions.find(x=>x.id===id);
  const i = STATUTS.indexOf(q.statut);
  q.statut = STATUTS[(i+1)%STATUTS.length];
  await dbPut('questions', q);
  renderBankList();
  toast('Statut : '+statutLabel(q.statut),'info');
}
function deleteQuestion(id){
  confirmModal('Supprimer la question ?','Action irréversible.',
    async ()=>{
      await dbDel('questions', id);
      State.questions = State.questions.filter(q=>q.id!==id);
      renderBankList();
      toast('Supprimée','success');
    }, {danger:true, confirmLabel:'Supprimer'});
}
function singleTrain(id){
  const q = State.questions.find(x=>x.id===id);
  if(!q) return;
  showView('train');
  State.session = {
    mode:'training', questions:[q], answers:{}, revealed:{}, submitted:{},
    index:0, started:Date.now(), remaining:0, scoreRule:'edn', finished:false, config:{}
  };
  renderSession();
  setTimeout(()=>$('#sessionArea')?.scrollIntoView({behavior:'smooth'}), 100);
}

/* ============ QUESTION FORM ============ */
function openNewQuestion(defaultCoursId){
  if(!State.cours.length){ toast('Crée d\'abord un cours','error'); return; }
  openModal(questionFormHTML(), { onMount: mountQuestionForm });
  if(defaultCoursId) $('#qCours').value = defaultCoursId;
}
function openEditQuestion(id){
  const q = State.questions.find(x=>x.id===id);
  if(!q) return;
  openModal(questionFormHTML(q), { onMount: ()=>mountQuestionForm(q) });
}
function questionFormHTML(q){
  const matOpts = State.matieres.map(m=>{
    const sel = q && getCours(q.coursId)?.matiereId === m.id ? 'selected' : '';
    return `<option value="${m.id}" ${sel}>${esc(m.nom)}</option>`;
  }).join('');
  const firstMatId = q ? (getCours(q.coursId)?.matiereId || State.matieres[0]?.id) : State.matieres[0]?.id;
  const coursForMat = firstMatId ? coursOfMatiere(firstMatId) : [];
  const coursOpts = coursForMat.map(c=>{
    const sel = q && q.coursId === c.id ? 'selected' : '';
    return `<option value="${c.id}" ${sel}>${esc(c.nom)}</option>`;
  }).join('');
  return `<h3>${q?'Modifier la question':'Nouvelle question'}</h3>
    <p class="modal-sub">Remplis les champs ci-dessous</p>
    <div class="form-grid">
      <div><label class="field">Matière</label><select id="qMatiere">${matOpts}</select></div>
      <div><label class="field">Cours</label><select id="qCours">${coursOpts}</select></div>
      <div><label class="field">Section</label><input type="text" id="qSection" value="${esc(q?.section||'')}" placeholder="Ex : Voies sensitives"></div>
      <div><label class="field">Type</label><select id="qType">${Q_TYPES.map(t=>`<option ${q?.type===t?'selected':''}>${t}</option>`).join('')}</select></div>
      <div><label class="field">Difficulté</label><select id="qDiff">
        <option ${q?.difficulty==='Facile'?'selected':''}>Facile</option>
        <option ${(!q||q?.difficulty==='Standard')?'selected':''}>Standard</option>
        <option ${q?.difficulty==='Difficile'?'selected':''}>Difficile</option>
      </select></div>
      <div><label class="field">Statut</label><select id="qStatut">${STATUTS.map(s=>`<option value="${s}" ${q?.statut===s?'selected':''}>${statutLabel(s)}</option>`).join('')}</select></div>
    </div>
    <label class="field">Énoncé</label>
    <textarea id="qStem" style="min-height:80px">${esc(q?.stem||'')}</textarea>
    <label class="field">Propositions (une par ligne, vide pour QROC)</label>
    <textarea id="qOpts" style="min-height:100px">${esc((q?.opts||[]).join('\n'))}</textarea>
    <label class="field">Réponses correctes (indices 0-based, ex : 0,2)</label>
    <input type="text" id="qAns" value="${esc((q?.ans||[]).join(','))}">
    <label class="field">Éléments attendus (QROC/KFP)</label>
    <textarea id="qExpected" style="min-height:60px">${esc(q?.expected||'')}</textarea>
    <label class="field">Explication</label>
    <textarea id="qExp" style="min-height:70px">${esc(q?.exp||'')}</textarea>
    <label class="field">Source</label>
    <input type="text" id="qSource" value="${esc(q?.source||'')}" placeholder="Ex : p. 12">
    <div class="actions">
      <button class="btn btn-primary" id="btnSaveQ">${q?'Enregistrer':'Créer'}</button>
      <button class="btn btn-light" onclick="closeModal()">Annuler</button>
    </div>`;
}
function mountQuestionForm(q){
  $('#qMatiere').addEventListener('change', ()=>{
    const mid = $('#qMatiere').value;
    $('#qCours').innerHTML = coursOfMatiere(mid).map(c=>`<option value="${c.id}">${esc(c.nom)}</option>`).join('');
  });
  $('#btnSaveQ').onclick = async ()=>{
    const coursId = $('#qCours').value;
    if(!coursId){ toast('Sélectionne un cours','error'); return; }
    const stem = $('#qStem').value.trim();
    if(!stem){ toast('Énoncé requis','error'); return; }
    const type = $('#qType').value;
    const opts = $('#qOpts').value.split('\n').map(s=>s.trim()).filter(Boolean);
    const ans = $('#qAns').value.split(',').map(s=>Number(s.trim())).filter(n=>!isNaN(n) && n>=0 && n<opts.length);
    if(['QCM','QRM','QRU'].includes(type) && opts.length && !ans.length){
      toast('Indique au moins une réponse correcte','error'); return;
    }
    const data = {
      id: q?.id || uid(),
      coursId,
      section: $('#qSection').value.trim(),
      type, difficulty: $('#qDiff').value, statut: $('#qStatut').value,
      stem, opts, ans,
      expected: $('#qExpected').value.trim(),
      exp: $('#qExp').value.trim(),
      source: $('#qSource').value.trim(),
      tags: q?.tags||[], image: q?.image||null,
      box: q?.box??0, nextReview: q?.nextReview||null,
      attempts: q?.attempts||0, correctAttempts: q?.correctAttempts||0,
      lastResult: q?.lastResult??null, lastSeen: q?.lastSeen||null,
      createdAt: q?.createdAt||Date.now()
    };
    if(type==='QRU' && data.ans.length>1) data.ans = [data.ans[0]];
    await dbPut('questions', data);
    if(q){ State.questions = State.questions.map(x=>x.id===q.id?data:x); }
    else { State.questions.push(data); }
    closeModal();
    toast(q?'Question modifiée':'Question créée','success');
    if(State.view==='bank') renderBankList();
    if(State.session && State.session.finished) renderResults();
  };
}

/* ============ STATS ============ */
function renderStats(){
  const root = $('#stats');
  if(!State.questions.length){
    root.innerHTML = `<div class="page-title">Statistiques</div><div class="empty"><div class="empty-icon">📊</div><h3>Pas encore de données</h3><p>Révise quelques questions pour voir apparaître tes statistiques.</p></div>`;
    return;
  }
  const totalAttempts = State.questions.reduce((n,q)=>n+(q.attempts||0),0);
  const totalCorrect = State.questions.reduce((n,q)=>n+(q.correctAttempts||0),0);
  const accGlobal = pct(totalCorrect, totalAttempts);
  const byMat = State.matieres.map(m=>{
    const qs = questionsOfMatiere(m.id);
    const att = qs.reduce((n,q)=>n+(q.attempts||0),0);
    const cor = qs.reduce((n,q)=>n+(q.correctAttempts||0),0);
    return { m, n:qs.length, att, pct:pct(cor,att), due:qs.filter(isDue).length };
  }).filter(x=>x.n>0);
  const byCours = State.cours.map(c=>{
    const qs = questionsOfCours(c.id);
    const att = qs.reduce((n,q)=>n+(q.attempts||0),0);
    const cor = qs.reduce((n,q)=>n+(q.correctAttempts||0),0);
    return { c, n:qs.length, att, pct:pct(cor,att) };
  }).filter(x=>x.n>0).sort((a,b)=>a.pct-b.pct);
  const recent = State.history.slice(0,5);
  root.innerHTML = `
    <div class="page-title">Statistiques</div>
    <div class="page-sub">Progression par matière et cours</div>
    <div class="stats">
      <div class="stat blue"><div class="num">${State.questions.length}</div><div class="lbl">Questions</div></div>
      <div class="stat"><div class="num">${State.history.length}</div><div class="lbl">Séances</div></div>
      <div class="stat ${accGlobal>=70?'blue':'gold'}"><div class="num">${totalAttempts?accGlobal+'%':'—'}</div><div class="lbl">Réussite</div></div>
      <div class="stat gold"><div class="num">${dueCount()}</div><div class="lbl">À réviser</div></div>
    </div>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:14px">Par matière</h3>
      ${byMat.length ? byMat.map(x=>`
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <b style="font-size:13px">${esc(x.m.nom)}</b>
            <span class="small">${x.pct}% · ${x.att} tentatives${x.due?' · '+x.due+' à revoir':''}</span>
          </div>
          <div class="bar bar-thick ${x.pct>=70?'green':x.pct>=40?'gold':''}"><span style="width:${x.pct}%"></span></div>
        </div>
      `).join('') : '<p class="muted">Aucune donnée.</p>'}
    </div>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:14px">Par cours</h3>
      ${byCours.length ? byCours.map(x=>{
        const mat = getMatiere(x.c.matiereId);
        return `<div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;margin-bottom:5px">
            <b style="font-size:13px">${esc(x.c.nom)}</b>
            <span class="small">${esc(mat?.nom||'')} · ${x.pct}% · ${x.n} Q</span>
          </div>
          <div class="bar ${x.pct>=70?'green':x.pct>=40?'gold':''}"><span style="width:${x.pct}%"></span></div>
        </div>`;
      }).join('') : '<p class="muted">Aucune donnée.</p>'}
    </div>
    <div class="card">
      <h3 style="font-size:15px;margin-bottom:14px">Séances récentes</h3>
      ${recent.length ? recent.map(h=>`
        <div class="list-row">
          <div>
            <b style="font-size:13px">${new Date(h.date).toLocaleDateString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</b>
            <div class="small">${h.mode==='exam'?'Examen':'Apprentissage'} · ${h.total} Q${h.timeUp?' · temps écoulé':''}</div>
          </div>
          <span class="pill ${h.score>=70?'green':h.score>=40?'gold':'red'}">${h.score!==null?h.score+'%':'—'}</span>
        </div>
      `).join('') : '<p class="muted">Aucune séance.</p>'}
    </div>`;
}

/* ============ RÉGLAGES ============ */
function renderSettings(){
  const root = $('#settings');
  root.innerHTML = `
    <div class="page-title">Réglages</div>
    <div class="page-sub">Imports, sauvegardes, prompt IA</div>

    <div class="card">
      <h3 style="font-size:15px;margin-bottom:10px">📥 Import JSON (coller)</h3>
      <p class="small" style="margin-bottom:10px">Colle directement la réponse de ChatGPT. Les balises \`\`\`json sont retirées automatiquement.</p>
      <textarea id="pasteJsonArea" placeholder='{"questions": [...]}' style="min-height:160px;font-family:ui-monospace,Menlo,monospace;font-size:12px"></textarea>
      <div class="actions">
        <button class="btn btn-primary" onclick="importFromPaste()">Importer ce JSON</button>
        <button class="btn btn-light" onclick="clearPasteArea()">Vider</button>
      </div>
      <hr style="border:0;border-top:1px solid var(--border);margin:16px 0">
      <p class="small" style="margin-bottom:10px">Ou importe un fichier (banque ou sauvegarde complète) :</p>
      <div class="actions">
        <button class="btn btn-outline" onclick="$('#importFile').click()">Importer un fichier .json</button>
        <button class="btn btn-light" onclick="exportBackup()">Sauvegarde complète</button>
        <button class="btn btn-outline" onclick="exportBank()">Exporter la banque</button>
        <button class="btn btn-outline" onclick="exportHistoryCSV()">Historique CSV</button>
      </div>
      <p class="small" style="margin-top:10px">Dernière sauvegarde : <b>${State.config.lastBackupDate ? new Date(State.config.lastBackupDate).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'}) : 'jamais'}</b></p>
    </div>

    <div class="card">
      <h3 style="font-size:15px;margin-bottom:10px">🤖 Prompt IA</h3>
      <p class="small" style="margin-bottom:10px">Copie ce prompt, joins ton PDF dans ChatGPT, colle le JSON renvoyé dans la zone ci-dessus.</p>
      <textarea id="promptText" readonly style="min-height:220px;font-size:12px"></textarea>
      <div class="actions">
        <button class="btn btn-primary" onclick="copyPrompt()">Copier le prompt</button>
        <button class="btn btn-light" onclick="window.open('https://chatgpt.com/','_blank')">Ouvrir ChatGPT</button>
      </div>
    </div>

    <div class="card">
      <h3 style="font-size:15px;margin-bottom:10px">📋 Format attendu</h3>
      <details>
        <summary>Voir le schéma JSON</summary>
        <pre>{
  "questions": [{
    "matiere": "Neurologie",
    "cours": "Moelle spinale",
    "section": "Voies sensitives",
    "type": "QCM",
    "difficulty": "Standard",
    "stem": "Énoncé",
    "opts": ["A", "B", "C", "D", "E"],
    "ans": [0, 2],
    "exp": "Explication",
    "expected": "",
    "source": "p.12",
    "tags": [],
    "image": null,
    "statut": "à_vérifier"
  }]
}</pre>
      </details>
    </div>

    <div class="card" style="border-color:var(--danger)">
      <h3 style="font-size:15px;margin-bottom:10px;color:var(--danger)">⚠ Zone dangereuse</h3>
      <div class="actions"><button class="btn btn-danger" onclick="resetAll()">Tout effacer</button></div>
    </div>

    <p class="small" style="text-align:center;margin-top:20px">v3.1 · Tes données restent sur cet appareil.</p>`;
  $('#promptText').value = buildPrompt();
}

function buildPrompt(){
  return `Tu es un concepteur de QCM pour étudiant en médecine DFGSM3 (préparation EDN).

Analyse le PDF joint et crée un sujet STRICTEMENT fondé sur ce document.

OBJECTIF
- 25 à 30 questions, niveau EDN progressif.
- Répartition : ~70% QCM/QRM, ~10% QRU, ~10% QROC, ~10% cas clinique/KFP.
- Mélange rappel, mécanismes, raisonnement clinique.
- Chaque proposition doit être clairement vraie ou fausse au regard du PDF.
- Ne PAS inventer de page. Si tu ne peux pas citer la section exacte, cite le titre de section.
- Ne complète PAS avec des connaissances externes : si une info manque dans le PDF, ne pose pas la question.
- Explique pourquoi les propositions fausses sont fausses.
- Vérifie une seconde fois la cohérence. En cas de doute, retire la question.

FORMAT DE SORTIE (JSON strict, sans Markdown, sans texte autour) :
{
  "questions": [{
    "matiere": "Neurologie",
    "cours": "Moelle spinale",
    "section": "Voies sensitives",
    "type": "QCM|QRM|QRU|QROC|KFP",
    "difficulty": "Facile|Standard|Difficile",
    "stem": "Énoncé",
    "opts": ["Proposition A","B","C","D","E"],
    "ans": [0,2],
    "expected": "",
    "exp": "Correction détaillée et concise",
    "source": "Section ou page du PDF",
    "tags": ["notion1","notion2"],
    "image": null,
    "statut": "à_vérifier"
  }]
}

RÈGLES CRITIQUES PAR TYPE
- QCM/QRM : opts remplis, ans = indices 0-based multiples.
- QRU : opts remplis, ans = EXACTEMENT 1 indice.
- QROC : opts = [], ans = [], expected = éléments attendus, exp = correction courte.
- KFP : comme QROC.
- matiere, cours, section : noms fidèles au PDF.
- "image" : null (ou data URL base64 si indispensable).
- Le JSON doit être importable directement, sans retouche.`;
}

function copyPrompt(){
  const ta = $('#promptText');
  ta.select();
  navigator.clipboard.writeText(ta.value).then(()=>toast('Prompt copié','success')).catch(()=>toast('Sélectionne et copie manuellement','error'));
}

/* ============ IMPORT ============ */
async function importFromPaste(){
  const raw = $('#pasteJsonArea')?.value.trim();
  if(!raw){ toast('La zone est vide','error'); return; }
  try {
    await handleImportedRaw(raw);
    clearPasteArea();
  } catch(err){
    toast('Import impossible : '+err.message,'error');
    console.error(err);
  }
}
function clearPasteArea(){ const ta = $('#pasteJsonArea'); if(ta) ta.value = ''; }

$('#importFile').addEventListener('change', async e=>{
  const f = e.target.files?.[0];
  if(!f) return;
  try {
    const raw = await f.text();
    await handleImportedRaw(raw);
  } catch(err){
    toast('Import impossible : '+err.message,'error');
    console.error(err);
  }
  e.target.value = '';
});

async function handleImportedRaw(rawString){
  const data = parseJSONRobust(rawString);

  // Détection sauvegarde complète
  if(data && !Array.isArray(data) && Array.isArray(data.matieres) && Array.isArray(data.cours) && Array.isArray(data.questions)){
    if(!confirm('Sauvegarde complète détectée. Remplacer les données actuelles ?')) return;
    for(const s of ['matieres','cours','questions','history','meta']) await dbClear(s);
    for(const m of data.matieres) await dbPut('matieres', m);
    for(const c of data.cours) await dbPut('cours', c);
    for(const q of data.questions) await dbPut('questions', q);
    for(const h of (data.history || [])) await dbPut('history', h);
    if(data.config) await dbPut('meta', { key:'config', value: data.config });
    await loadAll();
    toast('Sauvegarde restaurée','success');
    showView('home');
    return;
  }

  // Import banque
  const arr = Array.isArray(data) ? data : data.questions;
  if(!Array.isArray(arr)) throw new Error("Le JSON doit contenir 'questions'.");
  let createdMat = 0, createdCours = 0, imported = 0, skipped = 0;
  for(const rawQ of arr){
    let matiere;
    if(rawQ.matiere){
      matiere = State.matieres.find(m=>m.nom.toLowerCase()===rawQ.matiere.toLowerCase());
      if(!matiere){
        matiere = { id: uid(), nom: rawQ.matiere, couleur: MATIERE_COLORS[State.matieres.length%MATIERE_COLORS.length], createdAt: Date.now() };
        await dbPut('matieres', matiere);
        State.matieres.push(matiere);
        createdMat++;
      }
    } else if(rawQ.coursId && getCours(rawQ.coursId)){
      const c = getCours(rawQ.coursId);
      matiere = getMatiere(c.matiereId);
    }
    if(!matiere){ skipped++; continue; }

    let cours;
    if(rawQ.coursId && getCours(rawQ.coursId)){
      cours = getCours(rawQ.coursId);
    } else if(rawQ.cours){
      cours = State.cours.find(c=>c.matiereId===matiere.id && c.nom.toLowerCase()===rawQ.cours.toLowerCase());
      if(!cours){
        cours = { id: uid(), matiereId: matiere.id, nom: rawQ.cours, createdAt: Date.now() };
        await dbPut('cours', cours);
        State.cours.push(cours);
        createdCours++;
      }
    } else { skipped++; continue; }

    const type = (rawQ.type||'QCM').toUpperCase();
    const q = {
      id: uid(), coursId: cours.id,
      section: rawQ.section||'',
      type: Q_TYPES.includes(type)?type:'QCM',
      difficulty: rawQ.difficulty||'Standard',
      statut: STATUTS.includes(rawQ.statut)?rawQ.statut:'à_vérifier',
      stem: rawQ.stem||'',
      opts: Array.isArray(rawQ.opts)?rawQ.opts:(Array.isArray(rawQ.options)?rawQ.options:[]),
      ans: Array.isArray(rawQ.ans)?rawQ.ans:(Array.isArray(rawQ.answers)?rawQ.answers:[]),
      expected: rawQ.expected||'',
      exp: rawQ.exp||rawQ.explanation||'',
      source: rawQ.source||'',
      tags: Array.isArray(rawQ.tags)?rawQ.tags:[],
      image: rawQ.image||null,
      box: 0, nextReview: null,
      attempts: 0, correctAttempts: 0,
      lastResult: null, lastSeen: null,
      createdAt: Date.now()
    };
    if(q.type==='QRU' && q.ans.length>1) q.ans = [q.ans[0]];
    if(!q.stem){ skipped++; continue; }
    await dbPut('questions', q);
    State.questions.push(q);
    imported++;
  }
  toast(`${imported} importée(s)${createdMat?` · ${createdMat} matière(s)`:''}${createdCours?` · ${createdCours} cours`:''}${skipped?` · ${skipped} ignorée(s)`:''}`,'success');
  showView('bank');
}

/* ============ EXPORT ============ */
function downloadBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function exportBank(){
  const blob = new Blob([JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    matieres: State.matieres,
    cours: State.cours,
    questions: State.questions.map(q=>({
      matiere: getMatiere(getCours(q.coursId)?.matiereId)?.nom,
      cours: getCours(q.coursId)?.nom,
      ...q
    }))
  }, null, 2)], {type:'application/json'});
  downloadBlob(blob, 'banque-medecine-'+todayStr()+'.json');
}
async function exportBackup(){
  const blob = new Blob([JSON.stringify({
    version: 3,
    exportedAt: new Date().toISOString(),
    matieres: State.matieres,
    cours: State.cours,
    questions: State.questions,
    history: State.history,
    config: State.config
  }, null, 2)], {type:'application/json'});
  downloadBlob(blob, 'sauvegarde-'+todayStr()+'.json');
  await updateBackupDate();
  toast('Sauvegarde exportée','success');
}
function exportHistoryCSV(){
  const rows = [['date','mode','total','qcm_total','qcm_correct','score','score_exact','duration_s']];
  State.history.forEach(h=>rows.push([h.date,h.mode,h.total,h.qcmTotal,h.qcmCorrect,h.score,h.scoreExact,h.timeSeconds]));
  const csv = rows.map(r=>r.map(x=>'"'+String(x??'').replace(/"/g,'""')+'"').join(',')).join('\n');
  downloadBlob(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}), 'historique.csv');
}
async function resetAll(){
  confirmModal('Tout effacer ?','Toutes les données seront supprimées définitivement.',
    async ()=>{
      for(const s of ['matieres','cours','questions','history','meta']) await dbClear(s);
      await loadAll();
      toast('Tout effacé','success');
      showView('home');
    }, {danger:true, confirmLabel:'Effacer définitivement'});
}

/* ============ RACCOURCIS CLAVIER ============ */
function isTextTarget(el){
  if(!el) return false;
  const tag = el.tagName;
  if(tag==='TEXTAREA' || tag==='SELECT') return true;
  if(tag==='INPUT'){
    const type = el.type.toLowerCase();
    return !['checkbox','radio','button','submit'].includes(type);
  }
  return el.isContentEditable;
}
function toggleOptionByIndex(idx){
  const s = State.session;
  if(!s || s.finished) return;
  const q = s.questions[s.index];
  if(['QROC','KFP'].includes(q.type)) return;
  if(idx<0 || idx>=q.opts.length) return;
  const current = s.answers[q.id] || [];
  if(q.type==='QRU'){
    s.answers[q.id] = [idx];
  } else {
    s.answers[q.id] = current.includes(idx) ? current.filter(x=>x!==idx) : [...current, idx];
  }
  const sel = `[name="ans_${CSS.escape(q.id)}"]`;
  document.querySelectorAll(sel).forEach(inp=>{
    inp.checked = (s.answers[q.id] || []).includes(Number(inp.value));
  });
}
document.addEventListener('keydown', e=>{
  if(isTextTarget(e.target)) return;
  if(e.target.tagName==='BUTTON') return;
  if(document.querySelector('.modal')) return;
  const s = State.session;
  if(!s || s.finished) return;
  if(!$('#sessionArea')?.querySelector('.q-card')) return;
  const key = e.key;
  const lower = key.toLowerCase();
  const letterMap = {a:0,b:1,c:2,d:3,e:4};
  if(letterMap[lower]!==undefined){ e.preventDefault(); toggleOptionByIndex(letterMap[lower]); return; }
  const numMap = {'1':0,'2':1,'3':2,'4':3,'5':4};
  if(numMap[key]!==undefined){ e.preventDefault(); toggleOptionByIndex(numMap[key]); return; }
  if(key==='Enter' || key===' '){
    e.preventDefault();
    const q = s.questions[s.index];
    const isRevealed = s.revealed[q.id] || s.mode==='exam';
    if(!isRevealed && s.mode!=='exam') revealAnswer();
    else if(s.index >= s.questions.length-1) finishSession(false);
    else nextQ();
    return;
  }
  if(key==='ArrowRight'){ e.preventDefault(); nextQ(); }
  if(key==='ArrowLeft'){ e.preventDefault(); prevQ(); }
});

/* ============ INIT ============ */
(async function init(){
  try {
    db = await openDB();
    await loadAll();
    if(navigator.storage && navigator.storage.persist){
      try {
        const ok = await navigator.storage.persist();
        console.log(ok ? '✅ Stockage persistant accordé' : '⚠ Stockage persistant refusé');
      } catch(e){}
    }
    renderHome();
    renderBackupBanner();
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }
  } catch(err){
    document.body.innerHTML = `<div style="padding:40px;text-align:center;font-family:sans-serif"><h2>Erreur de démarrage</h2><p>${err.message}</p><p>Vérifie que l'app est ouverte depuis une URL HTTPS.</p></div>`;
    console.error(err);
  }
})(); 
