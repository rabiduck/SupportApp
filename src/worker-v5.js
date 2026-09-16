import appWorker from './worker-v4.js';
import configWorker from './worker-v3.js';
import { managerEmployees } from './manager-employees.js';
import { authenticate } from './auth/index.js';
import { createLocalSession, clearSessionCookie, destroyLocalSession, sessionCookie, setLocalPassword, verifyLocalPassword } from './auth/local.js';
import { ensureSchema } from './schema.js';

const h = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

async function row(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

function redirect(request, path, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString(), ...headers } });
}

function withIdentityHeader(request, email) {
  const headers = new Headers(request.headers);
  headers.delete('Cf-Access-Authenticated-User-Email');
  if (email) headers.set('Cf-Access-Authenticated-User-Email', email);
  return new Request(request, { headers });
}

function simplePage(title, content, status = 200) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Authentication</div></header><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div></div></div>${content}</main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function accessPage(title, message, status = 403) {
  return simplePage(title, `<div class="notice"><strong>${h(message)}</strong></div>`, status);
}

function loginPage(message = '') {
  return simplePage('Sign in', `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card" style="max-width:520px"><form method="post" action="/login"><label>Username or email<input name="identity" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="action-bar"><button type="submit">Sign in</button></div></form></div>`);
}

function setupPage(message = '') {
  return simplePage('Initial setup', `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="notice"><strong>Create the first local login</strong><br>Enter the username of an existing active SystemAdmin and choose its initial password.</div><div class="form-card" style="max-width:520px"><form method="post" action="/setup"><label>SystemAdmin username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><div class="action-bar"><button type="submit">Create login</button></div></form></div>`);
}

async function localAuthRoutes(request, db, path) {
  const method = request.method.toUpperCase();
  const credentialCount = Number((await row(db, 'SELECT COUNT(*) AS c FROM employee_credentials'))?.c || 0);

  if (path === '/setup') {
    if (credentialCount > 0) return redirect(request, '/login');
    if (method === 'GET') return setupPage();
    if (method === 'POST') {
      const form = await request.formData();
      const username = String(form.get('username') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      const confirm = String(form.get('confirm_password') || '');
      if (password !== confirm) return setupPage('The passwords do not match.');
      const admin = await row(db, `SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id WHERE e.is_active=1 AND LOWER(e.username)=? AND r.name='SystemAdmin'`, username);
      if (!admin) return setupPage('That username is not an active SystemAdmin account.');
      try { await setLocalPassword(db, admin.id, password); }
      catch (error) { return setupPage(error?.message || String(error)); }
      const token = await createLocalSession(db, admin.id);
      return redirect(request, '/', { 'Set-Cookie': sessionCookie(token) });
    }
  }

  if (path === '/login') {
    if (credentialCount === 0) return redirect(request, '/setup');
    if (method === 'GET') return loginPage();
    if (method === 'POST') {
      const form = await request.formData();
      const supplied = String(form.get('identity') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      const employee = await row(db, `SELECT id FROM employees WHERE is_active=1 AND (LOWER(username)=? OR LOWER(email)=?) LIMIT 1`, supplied, supplied);
      if (!employee || !(await verifyLocalPassword(db, employee.id, password))) return loginPage('The username/email or password was not recognised.');
      const token = await createLocalSession(db, employee.id);
      return redirect(request, '/', { 'Set-Cookie': sessionCookie(token) });
    }
  }

  if (path === '/logout') {
    await destroyLocalSession(request, db);
    return redirect(request, '/login', { 'Set-Cookie': clearSessionCookie() });
  }

  if (credentialCount === 0) return redirect(request, '/setup');
  return null;
}

async function resolveUser(db, identity) {
  if (identity?.employeeId) {
    const direct = await row(db, 'SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE id=? AND is_active=1', identity.employeeId);
    if (direct) return enrichUser(db, direct);
  }
  const email = String(identity?.email || '').trim().toLowerCase();
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!email && !username) return null;
  const employee = await row(db, `SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE is_active=1 AND ((?<>'' AND (LOWER(email)=? OR LOWER(external_identity)=?)) OR (?<>'' AND LOWER(username)=?)) LIMIT 1`, email,email,email,username,username);
  return employee ? enrichUser(db, employee) : null;
}

async function enrichUser(db, employee) {
  const roleRows = await rows(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name`, employee.id);
  const roles = roleRows.map((r) => r.name);
  const managedTeamRows = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  const isSystemAdmin = roles.includes('SystemAdmin');
  const isManager = roles.includes('Manager');
  const isTeamLeader = roles.includes('TeamLeader');
  return { ...employee, roles, isSystemAdmin, isManager, isTeamLeader, primaryRole: isSystemAdmin ? 'SystemAdmin' : isManager ? 'Manager' : isTeamLeader ? 'TeamLeader' : 'Employee', managedTeamIds: managedTeamRows.map((x) => Number(x.team_id)) };
}

function nav(user, active = '') {
  const isAdmin = user.isManager || user.isTeamLeader || user.isSystemAdmin;
  const sections = [
    {name:'Rota', items:[
      ['Calendar','/rota','Rota'],
      ['My Requests','/leave','My Leave'],
      ['On Call','/on-call','On Call'],
      ['Gatekeepers','/gatekeepers','Gatekeepers']
    ]},
    {name:'PDP', items:[
      ['My Skills','/pdp/my-skills','PDP My Skills'],
      ...(isAdmin ? [['Team Skills','/pdp/team-skills','PDP Team Skills'],['PDP Configuration','/pdp/config','PDP Configuration']] : [])
    ]},
    ...(isAdmin ? [{name:'Administration', items:[
      ['Leave Requests','/leave-requests','Leave Requests'],
      ['WFH Requests','/wfh-requests','WFH Requests'],
      ['Employees','/employees','Employees'],
      ['Shift Patterns','/shift-patterns','Shift Patterns'],
      ...(user.isSystemAdmin ? [['Teams','/teams','Teams'],['Leave Years','/leave-years','Leave Years'],['System Administration','/administration','Administration']] : [])
    ]}] : [])
  ];
  const dashboard = (user.isManager || user.isSystemAdmin) ? `<a class="nav-top ${active==='Dashboard'?'active':''}" href="/">Dashboard</a>` : '';
  return dashboard + sections.map((section,si)=>{
    const open=section.items.some(([, ,key])=>key===active);
    return `<div class="nav-group"><button type="button" class="nav-group-toggle" data-nav-group="${si}" aria-expanded="${open?'true':'false'}"><span>${section.name}</span><span class="nav-chevron">›</span></button><div class="nav-children" data-nav-children="${si}" ${open?'':'hidden'}>${section.items.map(([label,href,key])=>`<a class="${active===key?'active':''}" href="${href}">${label}</a>`).join('')}</div></div>`;
  }).join('');
}
function modalScript(){return `<script>(()=>{document.querySelectorAll('[data-modal-open]').forEach(b=>b.addEventListener('click',()=>{const d=document.getElementById(b.dataset.modalOpen);if(d)d.showModal()}));document.querySelectorAll('[data-modal-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog')?.close()));document.querySelectorAll('dialog.app-modal').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close()}));document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelector('dialog.app-modal[open]')?.close()})})()</script>`;}
function navTreeScript(){return `<script>(()=>{document.querySelectorAll('.nav-group-toggle').forEach(b=>{const id=b.dataset.navGroup,c=document.querySelector('[data-nav-children="'+id+'"]'),key='supportapp.nav.'+b.querySelector('span').textContent;const current=b.getAttribute('aria-expanded')==='true';if(!current&&localStorage.getItem(key)==='open'){c.hidden=false;b.setAttribute('aria-expanded','true')}b.addEventListener('click',()=>{const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));c.hidden=open;localStorage.setItem(key,open?'closed':'open')})})})()</script>`;}

function activeForPath(path) {
  if (path === '/') return 'Dashboard';
  if (path.startsWith('/pdp/config') || path.startsWith('/pdp/skills')) return 'PDP Configuration';
  if (path.startsWith('/pdp/team-skills')) return 'PDP Team Skills';
  if (path.startsWith('/pdp/my-skills')) return 'PDP My Skills';
  if (path.startsWith('/on-call')) return 'On Call';
  if (path.startsWith('/gatekeeper')) return 'Gatekeepers';
  if (path.startsWith('/rota')) return 'Rota';
  if (path.startsWith('/leave-requests')) return 'Leave Requests';
  if (path.startsWith('/wfh-requests')) return 'WFH Requests';
  if (path.startsWith('/leave')) return 'My Leave';
  if (path.startsWith('/teams')) return 'Teams';
  if (path.startsWith('/employees')) return 'Employees';
  if (path.startsWith('/shift-') || path.startsWith('/week-patterns') || path.startsWith('/rota-patterns')) return 'Shift Patterns';
  if (path.startsWith('/leave-years')) return 'Leave Years';
  if (path.startsWith('/administration')) return 'Administration';
  return '';
}


async function pdpConfigPage(db,user){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const skills=await rows(db,'SELECT id,name,description,is_active FROM pdp_skills ORDER BY is_active DESC,name');
  const categories=await rows(db,'SELECT id,name,description,is_active,display_order FROM pdp_categories ORDER BY is_active DESC,display_order,name');
  const abilityScale=await rows(db,'SELECT score,level,explanation FROM pdp_ability_scale ORDER BY score DESC');
  const matrices=await rows(db,"SELECT m.id,m.name,m.description,m.is_active,COALESCE(GROUP_CONCAT(t.name, ', '),'—') teams FROM pdp_matrices m LEFT JOIN pdp_matrix_teams mt ON mt.matrix_id=m.id LEFT JOIN teams t ON t.id=mt.team_id GROUP BY m.id ORDER BY m.is_active DESC,m.name");
  const table=skills.length
    ? '<table><thead><tr><th>Skill</th><th>Description</th><th>Status</th><th></th></tr></thead><tbody>'+skills.map(s=>'<tr><td><strong>'+h(s.name)+'</strong></td><td>'+h(s.description||'—')+'</td><td>'+(s.is_active?'Active':'Inactive')+'</td><td><a class="button secondary" href="/pdp/skills/'+s.id+'/edit">Edit</a></td></tr>').join('')+'</tbody></table>'
    : '<div class="empty">No skills configured yet.</div>';
  const categoryTable=categories.length
    ? '<table><thead><tr><th>Category</th><th>Description</th><th>Status</th><th></th></tr></thead><tbody>'+categories.map(x=>'<tr><td><strong>'+h(x.name)+'</strong></td><td>'+h(x.description||'—')+'</td><td>'+(x.is_active?'Active':'Inactive')+'</td><td><a class="button secondary" href="/pdp/categories/'+x.id+'/edit">Edit</a></td></tr>').join('')+'</tbody></table>'
    : '<div class="empty">No categories configured yet.</div>';
  const abilityTable=abilityScale.length
    ? '<table><thead><tr><th>Score</th><th>Level</th><th>Explanation</th><th></th></tr></thead><tbody>'+abilityScale.map(x=>'<tr><td><strong>'+x.score+'</strong></td><td>'+h(x.level)+'</td><td>'+h(x.explanation)+'</td><td><a class="button secondary" href="/pdp/ability/'+x.score+'/edit">Edit</a></td></tr>').join('')+'</tbody></table>'
    : '<div class="empty">Ability scale has not been configured.</div>';
  const matrixTable=matrices.length
    ? '<table><thead><tr><th>Matrix</th><th>Description</th><th>Teams</th><th>Status</th><th></th></tr></thead><tbody>'+matrices.map(x=>'<tr><td><strong>'+h(x.name)+'</strong></td><td>'+h(x.description||'—')+'</td><td>'+h(x.teams)+'</td><td>'+(x.is_active?'Active':'Inactive')+'</td><td><a class="button secondary" href="/pdp/matrices/'+x.id+'/edit">Edit</a></td></tr>').join('')+'</tbody></table>'
    : '<div class="empty">No skills matrices configured yet.</div>';
  const content=''
    +'<h2>Skills Matrices</h2><div class="action-bar section-gap"><a class="button" href="/pdp/matrices/new">Create Matrix</a></div><div class="table-card">'+matrixTable+'</div>'
    +'<h2 class="section-gap">Skills</h2><div class="action-bar section-gap"><button type="button" data-modal-open="add-pdp-skill">Add Skill</button></div><div class="table-card">'+table+'</div>'
    +'<h2 class="section-gap">Categories</h2><div class="action-bar section-gap"><button type="button" data-modal-open="add-pdp-category">Add Category</button></div><div class="table-card">'+categoryTable+'</div>'
    +'<h2 class="section-gap">Ability Scale</h2><p class="muted">The 1–5 scores are fixed. Edit the level names and explanations to define what each score means for this PDP framework.</p><div class="table-card">'+abilityTable+'</div>'
    +'<dialog class="app-modal" id="add-pdp-category"><div class="modal-head"><h2>Add Category</h2><button type="button" class="modal-close" data-modal-close aria-label="Close">×</button></div><div class="modal-body"><form method="post" action="/pdp/categories"><label>Category Name<input name="name" required maxlength="120"></label><label>Description<textarea name="description" rows="4" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Add Category</button><button type="button" class="secondary" data-modal-close>Cancel</button></div></form></div></dialog>'
    +'<dialog class="app-modal" id="add-pdp-skill"><div class="modal-head"><h2>Add Skill</h2><button type="button" class="modal-close" data-modal-close aria-label="Close">×</button></div><div class="modal-body"><form method="post" action="/pdp/skills"><label>Skill Name<input name="name" required maxlength="120"></label><label>Description<textarea name="description" rows="4" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Add Skill</button><button type="button" class="secondary" data-modal-close>Cancel</button></div></form></div></dialog>';
  return appPage('PDP Configuration','Maintain the reusable skills catalogue used to build PDP matrices.',content,user,'PDP Configuration',db);
}
async function pdpMatrixStructureHtml(db,id){
  const availableCategories=await rows(db,'SELECT id,name FROM pdp_categories WHERE is_active=1 AND id NOT IN (SELECT category_id FROM pdp_matrix_categories WHERE matrix_id=?) ORDER BY display_order,name',id);
  const matrixCategories=await rows(db,'SELECT mc.id,mc.category_id,mc.display_order,c.name,c.description FROM pdp_matrix_categories mc JOIN pdp_categories c ON c.id=mc.category_id WHERE mc.matrix_id=? ORDER BY mc.display_order,c.name',id);
  const matrixSkills=await rows(db,'SELECT ms.id,ms.category_id,ms.skill_id,ms.display_order,s.name,s.description FROM pdp_matrix_skills ms JOIN pdp_skills s ON s.id=ms.skill_id WHERE ms.matrix_id=? ORDER BY ms.category_id,ms.display_order,s.name',id);
  const availableSkills=await rows(db,'SELECT id,name FROM pdp_skills WHERE is_active=1 AND id NOT IN (SELECT skill_id FROM pdp_matrix_skills WHERE matrix_id=?) ORDER BY name',id);
  const categories=matrixCategories.length?'<div class="matrix-builder">'+matrixCategories.map((x,i)=>{
    const skills=matrixSkills.filter(s=>Number(s.category_id)===Number(x.category_id));
    const skillRows=skills.length?skills.map((s,j)=>'<tr><td><strong>'+h(s.name)+'</strong></td><td>'+h(s.description||'—')+'</td><td class="matrix-order"><form class="inline-form matrix-ajax" method="post" action="/pdp/matrices/'+id+'/skills/'+s.id+'/move"><button class="secondary compact" name="direction" value="up" '+(j===0?'disabled':'')+' aria-label="Move skill up">↑</button><button class="secondary compact" name="direction" value="down" '+(j===skills.length-1?'disabled':'')+' aria-label="Move skill down">↓</button></form></td><td class="matrix-action"><form class="inline-form matrix-ajax" method="post" action="/pdp/matrices/'+id+'/skills/'+s.id+'/remove"><button class="secondary" type="submit">Remove</button></form></td></tr>').join(''):'<tr><td colspan="4" class="muted">No skills in this category.</td></tr>';
    const addSkill=availableSkills.length?'<tr class="matrix-add-row"><td colspan="4"><form class="matrix-add-form matrix-ajax" method="post" action="/pdp/matrices/'+id+'/skills"><input type="hidden" name="category_id" value="'+x.category_id+'"><select name="skill_id" required><option value="">— Add skill —</option>'+availableSkills.map(s=>'<option value="'+s.id+'">'+h(s.name)+'</option>').join('')+'</select><button type="submit">Add Skill</button></form></td></tr>':'<tr class="matrix-add-row"><td colspan="4" class="muted">All active skills are already used in this matrix.</td></tr>';
    return '<section class="matrix-category"><div class="matrix-category-head"><div><strong>'+h(x.name)+'</strong>'+(x.description?'<span class="muted"> — '+h(x.description)+'</span>':'')+'</div><div class="matrix-category-actions"><form class="inline-form matrix-ajax" method="post" action="/pdp/matrices/'+id+'/categories/'+x.id+'/move"><button class="secondary compact" name="direction" value="up" '+(i===0?'disabled':'')+' aria-label="Move category up">↑</button><button class="secondary compact" name="direction" value="down" '+(i===matrixCategories.length-1?'disabled':'')+' aria-label="Move category down">↓</button></form><form class="inline-form matrix-ajax" method="post" action="/pdp/matrices/'+id+'/categories/'+x.id+'/remove"><button class="secondary" type="submit">Remove Category</button></form></div></div><div class="table-card matrix-skill-table"><table><thead><tr><th>Skill</th><th>Description</th><th>Order</th><th></th></tr></thead><tbody>'+skillRows+addSkill+'</tbody></table></div></section>';
  }).join('')+'</div>':'<div class="empty">No categories have been added to this matrix yet.</div>';
  const addCategory=availableCategories.length?'<form class="matrix-add-form matrix-ajax section-gap" method="post" action="/pdp/matrices/'+id+'/categories"><select name="category_id" required><option value="">— Add category —</option>'+availableCategories.map(x=>'<option value="'+x.id+'">'+h(x.name)+'</option>').join('')+'</select><button type="submit">Add Category</button></form>':'<p class="muted section-gap">All active categories are already included in this matrix.</p>';
  return '<div id="matrix-structure" class="section-gap"><h2>Matrix Structure</h2><p class="muted">Add categories from the catalogue, arrange their order, then add and order skills within each category.</p>'+categories+addCategory+'</div>';
}
function pdpMatrixAjaxScript(){return '<script>(()=>{const root=document.getElementById("matrix-structure");if(!root)return;root.addEventListener("submit",async e=>{const form=e.target.closest("form.matrix-ajax");if(!form)return;e.preventDefault();const buttons=form.querySelectorAll("button");buttons.forEach(b=>b.disabled=true);try{const response=await fetch(form.action,{method:"POST",body:new FormData(form),headers:{"X-SupportApp-Partial":"matrix-structure"}});if(!response.ok)throw new Error("Request failed");root.outerHTML=await response.text()}catch(err){form.submit()}})})()</script>';}
async function pdpMatrixPage(request,db,user,id){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const teams=await rows(db,'SELECT id,name FROM teams WHERE is_active=1 ORDER BY name');
  let item={id:null,name:'',description:'',is_active:1}, selected=new Set();
  if(id){
    item=await row(db,'SELECT * FROM pdp_matrices WHERE id=?',id);
    if(!item) return accessPage('Matrix Not Found','That skills matrix does not exist.',404);
    const linked=await rows(db,'SELECT team_id FROM pdp_matrix_teams WHERE matrix_id=?',id); selected=new Set(linked.map(x=>Number(x.team_id)));
  }
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim(),active=form.get('is_active')==='1'?1:0;
    const teamIds=form.getAll('team_id').map(Number).filter(Number.isInteger);
    if(!name) return accessPage('Invalid Matrix','A matrix name is required.',400);
    if(id) await db.prepare('UPDATE pdp_matrices SET name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name,description||null,active,id).run();
    else { const result=await db.prepare('INSERT INTO pdp_matrices(name,description,is_active) VALUES(?,?,?)').bind(name,description||null,active).run(); id=Number(result.meta.last_row_id); }
    await db.prepare('DELETE FROM pdp_matrix_teams WHERE matrix_id=?').bind(id).run();
    for(const teamId of teamIds) await db.prepare('INSERT INTO pdp_matrix_teams(matrix_id,team_id) VALUES(?,?)').bind(id,teamId).run();
    return new Response(null,{status:303,headers:{Location:id?'/pdp/matrices/'+id+'/edit':'/pdp/config'}});
  }
  const teamChecks=teams.length?teams.map(t=>'<label class="check-row"><input type="checkbox" name="team_id" value="'+t.id+'" '+(selected.has(Number(t.id))?'checked':'')+'> '+h(t.name)+'</label>').join(''):'<div class="empty">No active teams are available.</div>';
  const structure=id?await pdpMatrixStructureHtml(db,id):'';
  const content='<div class="form-card matrix-details"><form method="post"><div class="matrix-details-grid"><div class="matrix-details-main"><label>Matrix Name<input name="name" value="'+h(item.name)+'" required maxlength="120"></label><label>Description<textarea name="description" rows="4" maxlength="500">'+h(item.description||'')+'</textarea></label><label>Status<select name="is_active"><option value="1" '+(item.is_active?'selected':'')+'>Active</option><option value="0" '+(!item.is_active?'selected':'')+'>Inactive</option></select></label></div><fieldset class="matrix-team-picker"><legend>Applicable Teams</legend>'+teamChecks+'</fieldset></div><div class="action-bar"><button type="submit">'+(id?'Save Changes':'Create Matrix')+'</button><a class="button secondary" href="/pdp/config">Cancel</a></div></form></div>'+structure+(id?pdpMatrixAjaxScript():'');
  return appPage(id?'Edit Skills Matrix':'Create Skills Matrix','Define the matrix and the teams it applies to.',content,user,'PDP Configuration',db);
}
async function pdpMatrixCategoryAction(request,db,user,matrixId,linkId,action){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const matrix=await row(db,'SELECT id FROM pdp_matrices WHERE id=?',matrixId); if(!matrix) return accessPage('Matrix Not Found','That skills matrix does not exist.',404);
  if(action==='add'){
    const form=await request.formData(),categoryId=Number(form.get('category_id')); if(!categoryId) return accessPage('Invalid Category','Select a category to add.',400);
    const category=await row(db,'SELECT id FROM pdp_categories WHERE id=? AND is_active=1',categoryId); if(!category) return accessPage('Category Not Found','That active category does not exist.',404);
    await db.prepare('INSERT OR IGNORE INTO pdp_matrix_categories(matrix_id,category_id,display_order) VALUES(?,?,COALESCE((SELECT MAX(display_order)+1 FROM pdp_matrix_categories WHERE matrix_id=?),0))').bind(matrixId,categoryId,matrixId).run();
  } else {
    const link=await row(db,'SELECT id,display_order FROM pdp_matrix_categories WHERE id=? AND matrix_id=?',linkId,matrixId); if(!link) return accessPage('Category Not Found','That category is not part of this matrix.',404);
    if(action==='remove') await db.prepare('DELETE FROM pdp_matrix_categories WHERE id=?').bind(linkId).run();
    if(action==='move'){
      const form=await request.formData(),direction=String(form.get('direction')||'');
      const op=direction==='up'?'<':'>', order=direction==='up'?'DESC':'ASC';
      if(direction!=='up'&&direction!=='down') return accessPage('Invalid Move','Choose a valid move direction.',400);
      const other=await row(db,'SELECT id,display_order FROM pdp_matrix_categories WHERE matrix_id=? AND display_order '+op+' ? ORDER BY display_order '+order+' LIMIT 1',matrixId,link.display_order);
      if(other){await db.prepare('UPDATE pdp_matrix_categories SET display_order=? WHERE id=?').bind(other.display_order,link.id).run();await db.prepare('UPDATE pdp_matrix_categories SET display_order=? WHERE id=?').bind(link.display_order,other.id).run();}
    }
  }
  if(request.headers.get('X-SupportApp-Partial')==='matrix-structure') return new Response(await pdpMatrixStructureHtml(db,matrixId),{headers:{'content-type':'text/html; charset=UTF-8'}});
  return new Response(null,{status:303,headers:{Location:'/pdp/matrices/'+matrixId+'/edit'}});
}
async function pdpMatrixSkillAction(request,db,user,matrixId,linkId,action){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const matrix=await row(db,'SELECT id FROM pdp_matrices WHERE id=?',matrixId); if(!matrix) return accessPage('Matrix Not Found','That skills matrix does not exist.',404);
  if(action==='add'){
    const form=await request.formData(),categoryId=Number(form.get('category_id')),skillId=Number(form.get('skill_id'));
    if(!categoryId||!skillId) return accessPage('Invalid Skill','Select a category and skill.',400);
    const category=await row(db,'SELECT id FROM pdp_matrix_categories WHERE matrix_id=? AND category_id=?',matrixId,categoryId);
    const skill=await row(db,'SELECT id FROM pdp_skills WHERE id=? AND is_active=1',skillId);
    if(!category||!skill) return accessPage('Invalid Skill','The selected category or skill is not available.',400);
    await db.prepare('INSERT OR IGNORE INTO pdp_matrix_skills(matrix_id,category_id,skill_id,display_order) VALUES(?,?,?,COALESCE((SELECT MAX(display_order)+1 FROM pdp_matrix_skills WHERE matrix_id=? AND category_id=?),0))').bind(matrixId,categoryId,skillId,matrixId,categoryId).run();
  } else {
    const link=await row(db,'SELECT id,category_id,display_order FROM pdp_matrix_skills WHERE id=? AND matrix_id=?',linkId,matrixId); if(!link) return accessPage('Skill Not Found','That skill is not part of this matrix.',404);
    if(action==='remove') await db.prepare('DELETE FROM pdp_matrix_skills WHERE id=?').bind(linkId).run();
    if(action==='move'){
      const form=await request.formData(),direction=String(form.get('direction')||''); if(direction!=='up'&&direction!=='down') return accessPage('Invalid Move','Choose a valid move direction.',400);
      const op=direction==='up'?'<':'>',order=direction==='up'?'DESC':'ASC';
      const other=await row(db,'SELECT id,display_order FROM pdp_matrix_skills WHERE matrix_id=? AND category_id=? AND display_order '+op+' ? ORDER BY display_order '+order+' LIMIT 1',matrixId,link.category_id,link.display_order);
      if(other){await db.prepare('UPDATE pdp_matrix_skills SET display_order=? WHERE id=?').bind(other.display_order,link.id).run();await db.prepare('UPDATE pdp_matrix_skills SET display_order=? WHERE id=?').bind(link.display_order,other.id).run();}
    }
  }
  if(request.headers.get('X-SupportApp-Partial')==='matrix-structure') return new Response(await pdpMatrixStructureHtml(db,matrixId),{headers:{'content-type':'text/html; charset=UTF-8'}});
  return new Response(null,{status:303,headers:{Location:'/pdp/matrices/'+matrixId+'/edit'}});
}
async function pdpCreateSkill(request,db,user){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const form=await request.formData(),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim();
  if(!name) return accessPage('Invalid Skill','A skill name is required.',400);
  try { await db.prepare('INSERT INTO pdp_skills(name,description) VALUES(?,?)').bind(name,description||null).run(); }
  catch(e){ if(String(e).includes('UNIQUE')) return accessPage('Skill Already Exists','A skill with that name already exists.',400); throw e; }
  return new Response(null,{status:303,headers:{Location:'/pdp/config'}});
}
async function pdpEditSkillPage(request,db,user,id){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const skill=await row(db,'SELECT * FROM pdp_skills WHERE id=?',id);
  if(!skill) return accessPage('Skill Not Found','That skill does not exist.',404);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim(),active=form.get('is_active')==='1'?1:0;
    if(!name) return accessPage('Invalid Skill','A skill name is required.',400);
    await db.prepare('UPDATE pdp_skills SET name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name,description||null,active,id).run();
    return new Response(null,{status:303,headers:{Location:'/pdp/config'}});
  }
  const content='<div class="page-header"><div><div class="page-title">Edit Skill</div><div class="page-description">Update the reusable skill definition. Existing historical PDP snapshots remain independent.</div></div></div>'
    +'<div class="form-card"><form method="post"><label>Skill Name<input name="name" value="'+h(skill.name)+'" required maxlength="120"></label><label>Description<textarea name="description" rows="4" maxlength="500">'+h(skill.description||'')+'</textarea></label><label>Status<select name="is_active"><option value="1" '+(skill.is_active?'selected':'')+'>Active</option><option value="0" '+(!skill.is_active?'selected':'')+'>Inactive</option></select></label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/pdp/config">Cancel</a></div></form></div>';
  return appPage('Edit Skill','Update the reusable skill definition. Existing historical PDP snapshots remain independent.',content,user,'PDP Configuration',db);
}
async function pdpCreateCategory(request,db,user){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const form=await request.formData(),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim();
  if(!name) return accessPage('Invalid Category','A category name is required.',400);
  try { await db.prepare('INSERT INTO pdp_categories(name,description,display_order) VALUES(?,?,COALESCE((SELECT MAX(display_order)+1 FROM pdp_categories),0))').bind(name,description||null).run(); }
  catch(e){ if(String(e).includes('UNIQUE')) return accessPage('Category Already Exists','A category with that name already exists.',400); throw e; }
  return new Response(null,{status:303,headers:{Location:'/pdp/config'}});
}
async function pdpEditCategoryPage(request,db,user,id){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  const item=await row(db,'SELECT * FROM pdp_categories WHERE id=?',id);
  if(!item) return accessPage('Category Not Found','That category does not exist.',404);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim(),active=form.get('is_active')==='1'?1:0;
    if(!name) return accessPage('Invalid Category','A category name is required.',400);
    await db.prepare('UPDATE pdp_categories SET name=?,description=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name,description||null,active,id).run();
    return new Response(null,{status:303,headers:{Location:'/pdp/config'}});
  }
  const content='<div class="form-card"><form method="post"><label>Category Name<input name="name" value="'+h(item.name)+'" required maxlength="120"></label><label>Description<textarea name="description" rows="4" maxlength="500">'+h(item.description||'')+'</textarea></label><label>Status<select name="is_active"><option value="1" '+(item.is_active?'selected':'')+'>Active</option><option value="0" '+(!item.is_active?'selected':'')+'>Inactive</option></select></label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/pdp/config">Cancel</a></div></form></div>';
  return appPage('Edit Category','Update the reusable PDP category.',content,user,'PDP Configuration',db);
}
async function pdpEditAbilityPage(request,db,user,score){
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
  if(score<1 || score>5) return accessPage('Invalid Score','Ability scores must be between 1 and 5.',400);
  const item=await row(db,'SELECT score,level,explanation FROM pdp_ability_scale WHERE score=?',score);
  if(!item) return accessPage('Ability Level Not Found','That ability level does not exist.',404);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),level=String(form.get('level')||'').trim(),explanation=String(form.get('explanation')||'').trim();
    if(!level || !explanation) return accessPage('Invalid Ability Level','Both a level name and explanation are required.',400);
    await db.prepare('UPDATE pdp_ability_scale SET level=?,explanation=?,updated_at=CURRENT_TIMESTAMP WHERE score=?').bind(level,explanation,score).run();
    return new Response(null,{status:303,headers:{Location:'/pdp/config'}});
  }
  const content='<div class="form-card"><form method="post"><label>Score<input value="'+item.score+'" disabled></label><label>Level<input name="level" value="'+h(item.level)+'" required maxlength="80"></label><label>Explanation<textarea name="explanation" rows="5" required maxlength="750">'+h(item.explanation)+'</textarea></label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/pdp/config">Cancel</a></div></form></div>';
  return appPage('Edit Ability Level','Define what score '+item.score+' means when employees and managers assess ability.',content,user,'PDP Configuration',db);
}
async function pdpPlaceholder(user,title,message,active){
  return appPage(title,message,'<div class="empty">This part of PDP Stage 1 will become available as the matrix configuration is built.</div>',user,active);
}

async function unreadCount(db, userId) { return Number((await row(db, 'SELECT COUNT(*) AS c FROM notifications WHERE recipient_employee_id=? AND read_at IS NULL', userId))?.c || 0); }
function mailboxHtml(count) { return `<a id="notification-mailbox" href="/notifications" title="Notifications" style="position:relative;color:inherit;text-decoration:none;font-size:20px;margin-right:14px">✉<span id="notification-badge" style="position:absolute;top:-9px;right:-12px;background:#e11d48;color:white;border-radius:999px;min-width:18px;height:18px;line-height:18px;text-align:center;font-size:11px;font-weight:700;padding:0 3px;${count ? '' : 'display:none;'}">${count > 9 ? '9+' : count}</span></a>`; }
function notificationPollScript() { return `<script>(()=>{const refresh=async()=>{if(document.hidden)return;try{const r=await fetch('/api/notifications/unread-count',{cache:'no-store',credentials:'same-origin'});if(!r.ok)return;const d=await r.json();const b=document.getElementById('notification-badge');if(!b)return;const n=Number(d.unread)||0;b.textContent=n>9?'9+':String(n);b.style.display=n?'':'none';}catch(_){}};setInterval(refresh,30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});})();</script>`; }

async function decorateResponse(response, user, path, localAuth = false, db = null) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<nav class="side-nav">[\s\S]*?<\/nav>/, `<nav class="side-nav">${nav(user, activeForPath(path))}</nav>`);
  const signout = localAuth ? ' · <a href="/logout" style="color:inherit">Sign out</a>' : '';
  const count = db ? await unreadCount(db, user.id) : 0;
  text = text.replace(/<div class="user-area">[\s\S]*?<\/div>/, `<div class="user-area">${mailboxHtml(count)}${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div>`);
  if (localAuth && path === '/employees' && (user.isManager || user.isSystemAdmin)) {
    text = text.replace(/<a class="button secondary" href="\/employees\/(\d+)\/edit">Edit<\/a>/g, (match, id) => `${match}<a class="button secondary" href="/employees/${id}/password">Password</a>`);
  }
  // Most application pages are rendered by the older workers and then decorated here,
  // so inject the live mailbox polling script during decoration as well.
  if (!text.includes('/api/notifications/unread-count')) {
    text = text.replace('</body>', `${notificationPollScript()}${modalScript()}${navTreeScript()}</body>`);
  }
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function isManagerConfigPath(path) {
  return path === '/shift-patterns' || path === '/week-patterns' || path === '/rota-patterns' || path === '/shift-types' || /^\/(week-patterns|rota-patterns|shift-types)\//.test(path);
}

async function passwordPage(request, db, currentUser, targetId) {
  const target = await row(db, `SELECT e.id,e.display_name,e.team_id,COALESCE(GROUP_CONCAT(r.name, ', '),'Employee') AS roles FROM employees e LEFT JOIN employee_roles er ON er.employee_id=e.id LEFT JOIN roles r ON r.id=er.role_id WHERE e.id=? GROUP BY e.id`, targetId);
  if (!target) return accessPage('Employee not found', 'The requested employee does not exist.', 404);
  const targetRoles = String(target.roles || '').split(',').map((x) => x.trim());
  const inScope = currentUser.isSystemAdmin || (currentUser.isManager && currentUser.managedTeamIds.includes(Number(target.team_id)) && !targetRoles.includes('Manager') && !targetRoles.includes('SystemAdmin'));
  if (!inScope) return accessPage('Access Denied', 'You cannot manage login credentials for this employee.', 403);

  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const password = String(form.get('password') || '');
    const confirm = String(form.get('confirm_password') || '');
    if (password !== confirm) return passwordForm(target, 'The passwords do not match.');
    try { await setLocalPassword(db, target.id, password); }
    catch (error) { return passwordForm(target, error?.message || String(error)); }
    return redirect(request, '/employees');
  }
  return passwordForm(target);
}

function passwordForm(target, message = '') {
  return simplePage(`Set password · ${target.display_name}`, `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card" style="max-width:520px"><p class="muted">Setting a new password also signs this user out of any existing sessions.</p><form method="post"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" required autofocus></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><div class="action-bar"><button type="submit">Set password</button><a class="button secondary" href="/employees">Cancel</a></div></form></div>`);
}

async function appPage(title, description, content, user, active = '', db = null) {
  const signout = ' · <a href="/logout" style="color:inherit">Sign out</a>';
  const count = db ? await unreadCount(db, user.id) : 0;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">${mailboxHtml(count)}${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div></header><div class="app-shell"><nav class="side-nav">${nav(user, active)}</nav><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div>${description ? `<div class="page-description">${h(description)}</div>` : ''}</div></div>${content}</main></div><footer class="footer">SupportApp · Cloudflare-native UAT</footer>${notificationPollScript()}${modalScript()}${navTreeScript()}</body></html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function leaveStatus(status) {
  const label = String(status || '').replace(/^./, (x) => x.toUpperCase());
  return `<span class="status-badge ${status === 'approved' ? 'status-active' : status === 'rejected' || status === 'cancelled' ? 'status-inactive' : ''}">${h(label)}</span>`;
}

async function createNotification(db, recipientId, type, title, message, targetUrl = null) {
  await db.prepare('INSERT INTO notifications (recipient_employee_id,notification_type,title,message,target_url) VALUES (?,?,?,?,?)').bind(recipientId,type,title,message,targetUrl).run();
}

async function notificationsPage(request, db, user) {
  if (request.method.toUpperCase() === 'POST') {
    const form=await request.formData(), action=String(form.get('action')||'mark_read');
    if(action==='delete_read') await db.prepare('DELETE FROM notifications WHERE recipient_employee_id=? AND read_at IS NOT NULL').bind(user.id).run();
    else if(action==='delete_one') await db.prepare('DELETE FROM notifications WHERE id=? AND recipient_employee_id=?').bind(Number(form.get('id')),user.id).run();
    else await db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE recipient_employee_id=?').bind(user.id).run();
    return redirect(request, '/notifications');
  }
  const items = await rows(db, 'SELECT * FROM notifications WHERE recipient_employee_id=? ORDER BY created_at DESC,id DESC LIMIT 100', user.id);
  const content = items.length ? `<div class="table-card"><table><thead><tr><th></th><th>Message</th><th>Received</th><th></th></tr></thead><tbody>${items.map(n=>`<tr><td>${n.read_at?'':'<strong>●</strong>'}</td><td><a href="/notifications/${n.id}"><strong>${h(n.title)}</strong></a><br><span class="muted">${h(n.message)}</span></td><td>${h(String(n.created_at||'').slice(0,16).replace('T',' '))}</td><td><form method="post"><input type="hidden" name="action" value="delete_one"><input type="hidden" name="id" value="${n.id}"><button type="submit" class="secondary">Delete</button></form></td></tr>`).join('')}</tbody></table></div><form method="post" class="section-gap" style="display:inline-block;margin-right:8px"><input type="hidden" name="action" value="mark_read"><button type="submit" class="secondary">Mark all read</button></form><form method="post" class="section-gap" style="display:inline-block"><input type="hidden" name="action" value="delete_read"><button type="submit" class="secondary">Delete all read</button></form>` : '<div class="empty">Your inbox is empty.</div>';
  return appPage('Notifications', 'Internal SupportApp messages and workflow updates.', content, user, '', db);
}

async function notificationOpen(request, db, user, id) {
  const n = await row(db, 'SELECT * FROM notifications WHERE id=? AND recipient_employee_id=?', id, user.id);
  if (!n) return accessPage('Notification not found','That notification does not exist.',404);
  await db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=?').bind(id).run();
  return redirect(request, n.target_url || '/notifications');
}

async function employeeRotaContext(db, employeeId) {
  return row(db, `SELECT e.id,e.team_id,COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,
    COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id WHERE e.id=?`, employeeId);
}
async function rotaAssignments(db, patternId) {
  return patternId ? rows(db, `SELECT rpw.week_number,wpd.day_of_week,st.is_working_day FROM rota_pattern_weeks rpw
    JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id JOIN shift_types st ON st.id=wpd.shift_type_id
    WHERE rpw.rota_pattern_id=?`, patternId) : [];
}
function cycleWeekOn(date, ctx) {
  if (!ctx.pattern_start_date || Number(ctx.cycle_length_weeks)<=0) return 1;
  const ps=new Date(`${ctx.pattern_start_date}T00:00:00Z`);
  const dw=Math.floor((date-ps)/(7*86400000)), n=Number(ctx.cycle_length_weeks);
  return ((dw%n)+n)%n+1;
}
function requestDays(request, ctx, amap, clipStart=null, clipEnd=null) {
  const start=new Date(`${request.start_date}T00:00:00Z`), end=new Date(`${request.end_date}T00:00:00Z`);
  let total=0;
  for(let d=new Date(start);d<=end;d.setUTCDate(d.getUTCDate()+1)){
    const day=d.toISOString().slice(0,10); if(clipStart&&day<clipStart)continue;if(clipEnd&&day>clipEnd)continue;
    const dow=(d.getUTCDay()+6)%7, shift=amap.get(`${cycleWeekOn(d,ctx)}:${dow}`);
    if(!shift?.is_working_day) continue;
    let portion='FULL'; if(day===request.start_date)portion=request.start_portion||'FULL'; if(day===request.end_date)portion=request.end_portion||'FULL';
    total += portion==='FULL' ? 1 : 0.5;
  }
  return total;
}
async function leaveBalance(db, employeeId, asOf=new Date().toISOString().slice(0,10)) {
  const annual=await row(db,"SELECT id FROM leave_types WHERE code='ANNUAL'"); if(!annual)return null;
  const year=await row(db,'SELECT id,name,start_date,end_date FROM leave_years WHERE is_active=1 AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1',asOf,asOf);
  if(!year)return null;
  const ent=await row(db,'SELECT entitlement_days,adjustment_days FROM employee_leave_entitlements WHERE employee_id=? AND leave_year_id=? AND leave_type_id=?',employeeId,year.id,annual.id);
  const ctx=await employeeRotaContext(db,employeeId); if(!ctx)return null;
  const assignments=await rotaAssignments(db,ctx.pattern_id), amap=new Map(assignments.map(a=>[`${a.week_number}:${a.day_of_week}`,a]));
  const reqs=await rows(db,'SELECT start_date,end_date,start_portion,end_portion,status FROM leave_requests WHERE employee_id=? AND leave_type_id=? AND end_date>=? AND start_date<=? AND status IN (\'approved\',\'pending\')',employeeId,annual.id,year.start_date,year.end_date);
  let taken=0,booked=0,pending=0;
  for(const r of reqs){
    if(r.status==='pending'){pending+=requestDays(r,ctx,amap,year.start_date,year.end_date);continue;}
    const before=new Date(asOf+'T00:00:00Z'); before.setUTCDate(before.getUTCDate()-1); const beforeIso=before.toISOString().slice(0,10);
    taken+=requestDays(r,ctx,amap,year.start_date,beforeIso);
    booked+=requestDays(r,ctx,amap,asOf,year.end_date);
  }
  const entitlement=Number(ent?.entitlement_days||0), adjustment=Number(ent?.adjustment_days||0);
  return {year,entitlement,adjustment,taken,booked,pending,remaining:entitlement+adjustment-taken-booked};
}
function balanceCard(b) {
  if(!b)return '<div class="notice"><strong>No active leave year configured.</strong></div>';
  const n=v=>Number(v||0).toFixed(1);
  const warning=b.remaining<0?`<div class="notice section-gap"><strong>⚠ Negative leave balance: ${n(b.remaining)} days</strong><br>Approved leave exceeds the current entitlement. This is advisory and does not prevent further requests or approvals.</div>`:'';
  return `<div class="card"><h2>Annual Leave · ${h(b.year.name)}</h2><p><strong>Entitlement:</strong> ${n(b.entitlement)} days &nbsp; <strong>Adjustment:</strong> ${b.adjustment>=0?'+':''}${n(b.adjustment)} &nbsp; <strong>Taken:</strong> ${n(b.taken)} &nbsp; <strong>Booked:</strong> ${n(b.booked)} &nbsp; <strong>Pending:</strong> ${n(b.pending)} &nbsp; <strong>Remaining:</strong> ${n(b.remaining)} days</p></div>${warning}`;
}

function mondayText(dateText){const d=new Date(dateText+'T12:00:00Z'),x=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-x);return d.toISOString().slice(0,10);}
async function gatekeeperMembers(db,teamId){return rows(db,'SELECT id,display_name,team_id,COALESCE(gatekeeper_order,999999) gatekeeper_order FROM employees WHERE team_id=? AND is_active=1 ORDER BY gatekeeper_order,display_name,id',teamId);}
async function gatekeeperEffectiveFor(db,teamId,dateText){
 const team=await row(db,'SELECT gatekeeper_enabled FROM teams WHERE id=? AND is_active=1',teamId);if(!team?.gatekeeper_enabled)return null;
 const ov=await row(db,'SELECT o.*,e.display_name FROM gatekeeper_overrides o JOIN employees e ON e.id=o.employee_id WHERE o.team_id=? AND o.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1',teamId,dateText,dateText);if(ov)return {employee_id:ov.employee_id,display_name:ov.display_name,source:ov.source};
 const members=await gatekeeperMembers(db,teamId),settings=await row(db,'SELECT * FROM gatekeeper_settings WHERE team_id=?',teamId);if(!members.length||!settings?.anchor_monday)return null;
 const mon=mondayText(dateText),weeks=Math.floor((new Date(mon+'T12:00:00Z')-new Date(settings.anchor_monday+'T12:00:00Z'))/604800000),a=Math.max(0,members.findIndex(m=>Number(m.id)===Number(settings.anchor_employee_id))),idx=((a+weeks)%members.length+members.length)%members.length;return {employee_id:members[idx].id,display_name:members[idx].display_name,source:'rotation'};
}
async function gatekeepersPage(request,db,user){
 const teams=await rows(db,'SELECT id,name,gatekeeper_enabled FROM teams WHERE is_active=1 AND gatekeeper_enabled=1 ORDER BY name');let cards='';
 if(!teams.length) cards='<div class="card"><p class="muted">No teams are currently configured for Gatekeeper rotation.</p></div>';
 for(const t of teams){const members=await gatekeeperMembers(db,t.id),set=await row(db,'SELECT * FROM gatekeeper_settings WHERE team_id=?',t.id),eff=await gatekeeperEffectiveFor(db,t.id,mondayText(new Date().toISOString().slice(0,10)));
 cards+=`<div class="card section-gap"><h2>${h(t.name)}</h2><p><strong>This week:</strong> ${eff?h(eff.display_name):'<span class="muted">Not configured</span>'}</p><p><strong>Rotation:</strong> ${members.map(m=>h(m.display_name)).join(' → ')||'<span class="muted">No active employees</span>'}</p>${(user.isManager||user.isTeamLeader)&&members.length>1?`<table><thead><tr><th>Order</th><th>Employee</th><th></th></tr></thead><tbody>${members.map((m,i)=>`<tr><td>${i+1}</td><td>${h(m.display_name)}</td><td><div class="action-bar"><form method="post" action="/gatekeepers/${t.id}/member/${m.id}/move"><input type="hidden" name="direction" value="up"><button class="secondary" ${i===0?'disabled':''}>↑</button></form><form method="post" action="/gatekeepers/${t.id}/member/${m.id}/move"><input type="hidden" name="direction" value="down"><button class="secondary" ${i===members.length-1?'disabled':''}>↓</button></form></div></td></tr>`).join('')}</tbody></table>`:''}${eff&&Number(eff.employee_id)===Number(user.id)?`<div class="action-bar"><a class="button secondary" href="/gatekeeper/cover?team=${t.id}&date=${mondayText(new Date().toISOString().slice(0,10))}&scope=week">Request Cover</a></div>`:''}${(user.isManager||user.isTeamLeader)?`<div class="action-bar"><a class="button secondary" href="/gatekeeper/override?team=${t.id}&date=${mondayText(new Date().toISOString().slice(0,10))}&scope=week">Override This Week</a></div><form method="post" action="/gatekeepers/${t.id}/anchor"><label>Anchor Monday<input type="date" name="anchor_monday" value="${h(set?.anchor_monday||mondayText(new Date().toISOString().slice(0,10)))}" required></label><label>Anchor Employee<select name="anchor_employee_id">${members.map(m=>`<option value="${m.id}" ${Number(m.id)===Number(set?.anchor_employee_id)?'selected':''}>${h(m.display_name)}</option>`).join('')}</select></label><button>Save Rotation Anchor</button></form>`:''}</div>`;}
 return appPage('Gatekeepers','Monday–Friday gatekeeper rotation by team.',cards,user,'Gatekeepers',db);
}
async function gatekeeperMove(request,db,user,teamId,employeeId){
 if(!(user.isManager||user.isTeamLeader)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 const members=await gatekeeperMembers(db,teamId),i=members.findIndex(m=>Number(m.id)===Number(employeeId)),form=await request.formData(),direction=String(form.get('direction')||''),j=direction==='up'?i-1:i+1;
 if(i>=0&&j>=0&&j<members.length){for(let n=0;n<members.length;n++) await db.prepare('UPDATE employees SET gatekeeper_order=? WHERE id=?').bind(n+1,members[n].id).run();await db.batch([db.prepare('UPDATE employees SET gatekeeper_order=? WHERE id=?').bind(j+1,members[i].id),db.prepare('UPDATE employees SET gatekeeper_order=? WHERE id=?').bind(i+1,members[j].id)]);}
 return redirect(request,'/gatekeepers');
}
async function gatekeeperAnchor(request,db,user,teamId){if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);const f=await request.formData();await db.prepare('INSERT INTO gatekeeper_settings(team_id,anchor_monday,anchor_employee_id) VALUES(?,?,?) ON CONFLICT(team_id) DO UPDATE SET anchor_monday=excluded.anchor_monday,anchor_employee_id=excluded.anchor_employee_id').bind(teamId,String(f.get('anchor_monday')),Number(f.get('anchor_employee_id'))).run();return redirect(request,'/gatekeepers');}
async function gatekeeperOverridePage(request,db,user){
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);const url=new URL(request.url),teamId=Number(url.searchParams.get('team')),date=String(url.searchParams.get('date')||''),scope=String(url.searchParams.get('scope')||'day'),members=await gatekeeperMembers(db,teamId),start=scope==='week'?mondayText(date):date,end=scope==='week'?(()=>{const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+4);return d.toISOString().slice(0,10)})():date;
 if(request.method.toUpperCase()==='POST'){const f=await request.formData(),eid=Number(f.get('employee_id')),notes=String(f.get('notes')||'').trim()||null;await db.prepare("INSERT INTO gatekeeper_overrides(team_id,start_date,end_date,employee_id,source,notes,recorded_by) VALUES(?,?,?,?,'manager',?,?)").bind(teamId,start,end,eid,notes,user.id).run();await createNotification(db,eid,'gatekeeper_override',`Gatekeeper assigned by ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}`,'/gatekeepers');return redirect(request,'/gatekeepers');}
 return appPage('Override Gatekeeper',scope==='week'?'Override Monday–Friday.':'Override one day.',`<div class="form-card"><form method="post"><label>Employee<select name="employee_id">${members.map(m=>`<option value="${m.id}">${h(m.display_name)}</option>`).join('')}</select></label><label>Notes<textarea name="notes"></textarea></label><button>Apply Override</button></form></div>`,user,'Gatekeepers',db);
}

async function gatekeeperCoverPage(request,db,user){
 const url=new URL(request.url),teamId=Number(url.searchParams.get('team')),date=String(url.searchParams.get('date')||''),scope=String(url.searchParams.get('scope')||'day'),effective=await gatekeeperEffectiveFor(db,teamId,date),members=await gatekeeperMembers(db,teamId);
 if(!effective||Number(effective.employee_id)!==Number(user.id))return accessPage('Access Denied','You can only request cover for your own current Gatekeeper duty.',403);
 const start=scope==='week'?mondayText(date):date,end=scope==='week'?(()=>{const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+4);return d.toISOString().slice(0,10)})():date;
 if(request.method.toUpperCase()==='POST'){const f=await request.formData(),mode=String(f.get('mode')||'open'),named=mode==='named'?Number(f.get('named_employee_id')):null,reason=String(f.get('reason')||'').trim()||null,made=await db.prepare('INSERT INTO gatekeeper_cover_requests(team_id,requester_id,scope,start_date,end_date,mode,named_employee_id,reason) VALUES(?,?,?,?,?,?,?,?)').bind(teamId,user.id,scope,start,end,mode,named,reason).run(),id=Number(made.meta?.last_row_id),recipients=mode==='named'?[named]:members.filter(m=>Number(m.id)!==Number(user.id)).map(m=>Number(m.id));for(const eid of recipients)await createNotification(db,eid,'gatekeeper_cover',`Gatekeeper cover requested by ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}${reason?` · ${reason}`:''}`,`/gatekeeper/cover/${id}`);return redirect(request,'/gatekeepers');}
 return appPage('Request Gatekeeper Cover',scope==='week'?'Request cover for the whole Gatekeeper week.':'Request cover for this day.',`<div class="form-card"><form method="post"><p><strong>${start}${end!==start?` → ${end}`:''}</strong></p><label>Request Type<select name="mode"><option value="open">Open request — first to accept</option><option value="named">Ask a specific team member</option></select></label><label>Specific Team Member<select name="named_employee_id">${members.filter(m=>Number(m.id)!==Number(user.id)).map(m=>`<option value="${m.id}">${h(m.display_name)}</option>`).join('')}</select></label><label>Reason <span class="muted">(optional)</span><textarea name="reason" rows="3"></textarea></label><button>Send Cover Request</button></form></div>`,user,'Gatekeepers',db);
}
async function gatekeeperCoverReview(request,db,user,id){
 const item=await row(db,'SELECT c.*,e.display_name requester_name FROM gatekeeper_cover_requests c JOIN employees e ON e.id=c.requester_id WHERE c.id=?',id);if(!item)return errorPage('Cover request not found.',user,404);
 const member=await row(db,'SELECT id FROM employees WHERE id=? AND team_id=? AND is_active=1',user.id,item.team_id),eligible=member&&Number(item.requester_id)!==Number(user.id)&&(item.mode==='open'||Number(item.named_employee_id)===Number(user.id));
 if(request.method.toUpperCase()==='POST'){if(!eligible)return accessPage('Access Denied','This cover request is not available to you.',403);const f=await request.formData(),action=String(f.get('action'));if(action==='decline'&&item.mode==='named'){await db.prepare("UPDATE gatekeeper_cover_requests SET status='declined',resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id).run();await createNotification(db,item.requester_id,'gatekeeper_cover_declined',`${user.display_name} declined Gatekeeper cover`,item.start_date,'/gatekeepers');return redirect(request,'/gatekeepers');}
 const claimed=await db.prepare("UPDATE gatekeeper_cover_requests SET status='accepted',accepted_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(user.id,id).run();if(Number(claimed.meta?.changes||0)!==1)return errorPage('This cover request has already been taken.',user,409);await db.prepare("INSERT INTO gatekeeper_overrides(team_id,start_date,end_date,employee_id,source,source_id,notes,recorded_by) VALUES(?,?,?,?, 'cover',?,?,?)").bind(item.team_id,item.start_date,item.end_date,user.id,id,item.reason||null,user.id).run();await createNotification(db,item.requester_id,'gatekeeper_cover_accepted',`${user.display_name} accepted your Gatekeeper cover`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}`,'/gatekeepers');return redirect(request,'/gatekeepers');}
 return appPage('Gatekeeper Cover',item.mode==='open'?'Open cover request':'Named cover request',`<div class="card"><h2>${h(item.requester_name)} needs Gatekeeper cover</h2><p><strong>${h(item.start_date)}${item.end_date!==item.start_date?` → ${h(item.end_date)}`:''}</strong></p>${item.reason?`<p>${h(item.reason)}</p>`:''}<p>Status: <strong>${h(item.status)}</strong></p>${eligible&&item.status==='pending'?`<form method="post" class="action-bar"><button name="action" value="accept">Take Cover</button>${item.mode==='named'?'<button name="action" value="decline" class="secondary">Decline</button>':''}</form>`:''}</div>`,user,'Gatekeepers',db);
}
function fridayFor(dateText){const d=new Date(dateText+'T12:00:00Z'),day=d.getUTCDay(),delta=(day-5+7)%7;d.setUTCDate(d.getUTCDate()-delta);return d.toISOString().slice(0,10);}
async function onCallMembers(db){return rows(db,`SELECT m.*,e.display_name,e.team_id FROM oncall_members m JOIN employees e ON e.id=m.employee_id WHERE m.is_active=1 AND e.is_active=1 ORDER BY m.display_order,m.id`);}
async function onCallBaseFor(db,dateText){
 const members=await onCallMembers(db),settings=await row(db,'SELECT * FROM oncall_settings WHERE id=1');if(!members.length||!settings?.anchor_friday)return null;
 const friday=fridayFor(dateText),weeks=Math.floor((new Date(friday+'T12:00:00Z')-new Date(settings.anchor_friday+'T12:00:00Z'))/604800000),anchor=Math.max(0,members.findIndex(m=>Number(m.id)===Number(settings.anchor_member_id))),idx=((anchor+weeks)%members.length+members.length)%members.length;return {member:members[idx],friday};
}
async function onCallEffectiveFor(db,dateText){const ov=await row(db,'SELECT o.*,e.display_name FROM oncall_overrides o JOIN employees e ON e.id=o.employee_id WHERE o.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1',dateText,dateText);if(ov)return {employee_id:ov.employee_id,display_name:ov.display_name,source:ov.source};const b=await onCallBaseFor(db,dateText);return b?{employee_id:b.member.employee_id,display_name:b.member.display_name,source:'rotation'}:null;}
async function onCallPage(request,db,user){
 const url=new URL(request.url),focus=String(url.searchParams.get('week')||new Date().toISOString().slice(0,10)),baseFriday=fridayFor(focus),members=await onCallMembers(db),settings=await row(db,'SELECT * FROM oncall_settings WHERE id=1');
 const weeks=[];for(let x=-2;x<=8;x++){const d=new Date(baseFriday+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+x*7);const fri=d.toISOString().slice(0,10),thu=new Date(d);thu.setUTCDate(thu.getUTCDate()+6);const eff=await onCallEffectiveFor(db,fri);weeks.push({fri,thu:thu.toISOString().slice(0,10),eff});}
 let manage='';if(user.isManager||user.isTeamLeader){const employees=await rows(db,'SELECT id,display_name FROM employees WHERE is_active=1 ORDER BY display_name');manage=`<div class="card section-gap"><h2>On Call Engineers</h2><table><thead><tr><th>Order</th><th>Engineer</th><th></th></tr></thead><tbody>${members.map((m,i)=>`<tr><td>${i+1}</td><td>${h(m.display_name)}</td><td><div class="action-bar"><form method="post" action="/on-call/member/${m.id}/move"><input type="hidden" name="direction" value="up"><button class="secondary" ${i===0?'disabled':''}>↑</button></form><form method="post" action="/on-call/member/${m.id}/move"><input type="hidden" name="direction" value="down"><button class="secondary" ${i===members.length-1?'disabled':''}>↓</button></form><form method="post" action="/on-call/member/${m.id}/remove"><button class="secondary">Remove</button></form></div></td></tr>`).join('')}</tbody></table><form method="post" action="/on-call/member/add" class="section-gap"><label>Add Engineer<select name="employee_id">${employees.filter(e=>!members.some(m=>Number(m.employee_id)===Number(e.id))).map(e=>`<option value="${e.id}">${h(e.display_name)}</option>`).join('')}</select></label><button>Add Engineer</button></form><form method="post" action="/on-call/anchor" class="section-gap"><h3>Rotation Anchor</h3><label>Friday<input type="date" name="anchor_friday" value="${h(settings?.anchor_friday||baseFriday)}" required></label><label>Engineer<select name="anchor_member_id">${members.map(m=>`<option value="${m.id}" ${Number(m.id)===Number(settings?.anchor_member_id)?'selected':''}>${h(m.display_name)}</option>`).join('')}</select></label><button>Save Anchor</button></form></div>`;}
 const table=`<table><thead><tr><th>On Call Week</th><th>Engineer</th><th></th></tr></thead><tbody>${weeks.map(w=>`<tr><td><strong>${w.fri}</strong> → ${w.thu}</td><td>${w.eff?h(w.eff.display_name):'<span class="muted">Not configured</span>'}</td><td>${w.eff&&Number(w.eff.employee_id)===Number(user.id)?`<a class="button secondary" href="/on-call/cover?date=${w.fri}&scope=week">Request Cover</a>`:''}${(user.isManager||user.isTeamLeader)&&w.eff?` <a class="button secondary" href="/on-call/override?date=${w.fri}&scope=week">Override</a>`:''}</td></tr>`).join('')}</tbody></table>`;
 return appPage('On Call','Friday–Thursday support cover.',`<div class="table-card">${table}</div>${manage}`,user,'On Call',db);
}
async function onCallMemberAction(request,db,user,action,id){
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 if(action==='add'){const form=await request.formData(),eid=Number(form.get('employee_id')),max=Number((await row(db,'SELECT COALESCE(MAX(display_order),0) m FROM oncall_members WHERE is_active=1'))?.m||0);await db.prepare('INSERT INTO oncall_members(employee_id,display_order,is_active) VALUES(?,?,1) ON CONFLICT(employee_id) DO UPDATE SET is_active=1,removed_at=NULL,display_order=excluded.display_order').bind(eid,max+1).run();}
 else await db.prepare('UPDATE oncall_members SET is_active=0,removed_at=CURRENT_TIMESTAMP WHERE id=?').bind(id).run();return redirect(request,'/on-call');
}
async function onCallMove(request,db,user,id){
 if(!(user.isManager||user.isTeamLeader)) return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 const form=await request.formData(),direction=String(form.get('direction')||''),members=await onCallMembers(db),i=members.findIndex(m=>Number(m.id)===Number(id)),j=direction==='up'?i-1:i+1;
 if(i>=0&&j>=0&&j<members.length){const a=members[i],b=members[j],ao=Number(a.display_order),bo=Number(b.display_order);await db.batch([db.prepare('UPDATE oncall_members SET display_order=? WHERE id=?').bind(bo,a.id),db.prepare('UPDATE oncall_members SET display_order=? WHERE id=?').bind(ao,b.id)]);}
 return redirect(request,'/on-call');
}
async function onCallAnchor(request,db,user){if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);const f=await request.formData();await db.prepare('UPDATE oncall_settings SET anchor_friday=?,anchor_member_id=? WHERE id=1').bind(String(f.get('anchor_friday')),Number(f.get('anchor_member_id'))).run();return redirect(request,'/on-call');}
async function onCallOverridePage(request,db,user){
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);const url=new URL(request.url),date=String(url.searchParams.get('date')||''),scope=String(url.searchParams.get('scope')||'day'),members=await onCallMembers(db),start=scope==='week'?fridayFor(date):date,end=scope==='week'?(()=>{const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+6);return d.toISOString().slice(0,10)})():date;
 if(request.method.toUpperCase()==='POST'){const f=await request.formData(),eid=Number(f.get('employee_id')),notes=String(f.get('notes')||'').trim()||null;await db.prepare("INSERT INTO oncall_overrides(start_date,end_date,employee_id,source,notes,recorded_by) VALUES(?,?,?,'manager',?,?)").bind(start,end,eid,notes,user.id).run();await createNotification(db,eid,'oncall_override',`On-call assigned by ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}`,'/on-call');return redirect(request,`/on-call?week=${start}`);}
 return appPage('Override On Call',scope==='week'?'Override the complete Friday–Thursday period.':'Override one day.',`<div class="form-card"><form method="post"><p><strong>${start}${end!==start?` → ${end}`:''}</strong></p><label>Engineer<select name="employee_id">${members.map(m=>`<option value="${m.employee_id}">${h(m.display_name)}</option>`).join('')}</select></label><label>Notes<textarea name="notes" rows="3"></textarea></label><button>Apply Override</button></form></div>`,user,'On Call',db);
}

async function onCallCoverPage(request,db,user){
 const url=new URL(request.url),date=String(url.searchParams.get('date')||''),scope=String(url.searchParams.get('scope')||'day'),effective=await onCallEffectiveFor(db,date),members=await onCallMembers(db);if(!effective||Number(effective.employee_id)!==Number(user.id))return accessPage('Access Denied','You can only request cover for your own current on-call duty.',403);
 const start=scope==='week'?fridayFor(date):date,end=scope==='week'?(()=>{const d=new Date(start+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+6);return d.toISOString().slice(0,10)})():date;
 if(request.method.toUpperCase()==='POST'){const f=await request.formData(),mode=String(f.get('mode')||'open'),named=mode==='named'?Number(f.get('named_employee_id')):null,reason=String(f.get('reason')||'').trim()||null;const made=await db.prepare('INSERT INTO oncall_cover_requests(requester_id,scope,start_date,end_date,mode,named_employee_id,reason) VALUES(?,?,?,?,?,?,?)').bind(user.id,scope,start,end,mode,named,reason).run(),id=Number(made.meta?.last_row_id);const recipients=mode==='named'?[named]:members.filter(m=>Number(m.employee_id)!==Number(user.id)).map(m=>Number(m.employee_id));for(const eid of recipients)await createNotification(db,eid,'oncall_cover',`On-call cover requested by ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}${reason?` · ${reason}`:''}`,`/on-call/cover/${id}`);return redirect(request,'/on-call');}
 return appPage('Request On-Call Cover',scope==='week'?'Request cover for the whole on-call week.':'Request cover for this day.',`<div class="form-card"><form method="post"><p><strong>${start}${end!==start?` → ${end}`:''}</strong></p><label>Request Type<select name="mode" id="cover-mode"><option value="open">Open request — first to accept</option><option value="named">Ask a specific engineer</option></select></label><label>Specific Engineer<select name="named_employee_id">${members.filter(m=>Number(m.employee_id)!==Number(user.id)).map(m=>`<option value="${m.employee_id}">${h(m.display_name)}</option>`).join('')}</select></label><label>Reason <span class="muted">(optional)</span><textarea name="reason" rows="3"></textarea></label><button>Send Cover Request</button></form></div>`,user,'On Call',db);
}
async function onCallCoverReview(request,db,user,id){
 const item=await row(db,'SELECT c.*,e.display_name requester_name FROM oncall_cover_requests c JOIN employees e ON e.id=c.requester_id WHERE c.id=?',id);if(!item)return errorPage('Cover request not found.',user,404);
 const member=await row(db,'SELECT id FROM oncall_members WHERE employee_id=? AND is_active=1',user.id),eligible=member&&Number(item.requester_id)!==Number(user.id)&&(item.mode==='open'||Number(item.named_employee_id)===Number(user.id));
 if(request.method.toUpperCase()==='POST'){if(!eligible)return accessPage('Access Denied','This cover request is not available to you.',403);const f=await request.formData(),action=String(f.get('action'));if(action==='decline'&&item.mode==='named'){await db.prepare("UPDATE oncall_cover_requests SET status='declined',resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(id).run();await createNotification(db,item.requester_id,'oncall_cover_declined',`${user.display_name} declined on-call cover`,item.start_date,'/on-call');return redirect(request,'/on-call');}
 const claimed=await db.prepare("UPDATE oncall_cover_requests SET status='accepted',accepted_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(user.id,id).run();if(Number(claimed.meta?.changes||0)!==1)return errorPage('This cover request has already been taken.',user,409);await db.prepare("INSERT INTO oncall_overrides(start_date,end_date,employee_id,source,source_id,notes,recorded_by) VALUES(?,?,?,'cover',?,?,?)").bind(item.start_date,item.end_date,user.id,id,item.reason||null,user.id).run();await createNotification(db,item.requester_id,'oncall_cover_accepted',`${user.display_name} accepted your on-call cover`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}`,'/on-call');return redirect(request,'/on-call');}
 const content=`<div class="card"><h2>${h(item.requester_name)} needs on-call cover</h2><p><strong>${h(item.start_date)}${item.end_date!==item.start_date?` → ${h(item.end_date)}`:''}</strong></p>${item.reason?`<p>${h(item.reason)}</p>`:''}<p>Status: <strong>${h(item.status)}</strong></p>${eligible&&item.status==='pending'?`<form method="post" class="action-bar"><button name="action" value="accept">Take Cover</button>${item.mode==='named'?'<button name="action" value="decline" class="secondary">Decline</button>':''}</form>`:''}</div>`;return appPage('On-Call Cover',item.mode==='open'?'Open cover request':'Named cover request',content,user,'On Call',db);
}

async function recordAttendancePage(request,db,user,kind){
 const url=new URL(request.url),employee=String(url.searchParams.get('employee')||''),date=String(url.searchParams.get('date')||'');
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 const target=await row(db,'SELECT id,display_name,team_id FROM employees WHERE display_name=? AND is_active=1',employee);
 if(!target||!/^\d{4}-\d{2}-\d{2}$/.test(date))return errorPage('Invalid employee or date.',user,400);
 const types=kind==='absence'?await rows(db,'SELECT id,name FROM absence_types WHERE is_active=1 ORDER BY name'):[];
 if(request.method.toUpperCase()==='POST'){
  const form=await request.formData(),end=String(form.get('end_date')||date),sp=String(form.get('start_portion')||'FULL'),ep=String(form.get('end_portion')||sp),notes=String(form.get('notes')||'').trim()||null;
  if(kind==='absence'){const type=Number(form.get('absence_type_id'));await db.prepare('INSERT INTO absences(employee_id,absence_type_id,start_date,end_date,start_portion,end_portion,notes,recorded_by) VALUES(?,?,?,?,?,?,?,?)').bind(target.id,type,date,end,sp,ep,notes,user.id).run();}
  else await db.prepare('INSERT INTO sickness(employee_id,start_date,end_date,start_portion,end_portion,notes,recorded_by) VALUES(?,?,?,?,?,?,?)').bind(target.id,date,end,sp,ep,notes,user.id).run();
  await createNotification(db,target.id,kind+'_recorded',`${kind==='absence'?'Absence':'Sickness'} recorded by ${user.display_name}`,`${date}${end!==date?` → ${end}`:''}`,'/rota');
  return redirect(request,`/rota?week=${date}`);
 }
 const typeField=kind==='absence'?`<label>Absence Type<select name="absence_type_id" required>${types.map(t=>`<option value="${t.id}">${h(t.name)}</option>`).join('')}</select></label>`:'';
 const content=`<div class="form-card"><h2>Record ${kind==='absence'?'Absence':'Sickness'} · ${h(target.display_name)}</h2><form method="post">${typeField}<label>Start Date<input type="date" value="${h(date)}" disabled></label><label>Start Portion<select name="start_portion"><option>FULL</option><option>AM</option><option>PM</option></select></label><label>End Date<input type="date" name="end_date" value="${h(date)}" min="${h(date)}" required></label><label>End Portion<select name="end_portion"><option>FULL</option><option>AM</option><option>PM</option></select></label><label>Notes <span class="muted">(optional)</span><textarea name="notes" rows="3"></textarea></label><div class="action-bar"><button>Record ${kind==='absence'?'Absence':'Sickness'}</button><a class="button secondary" href="/day?employee=${encodeURIComponent(target.display_name)}&date=${date}">Cancel</a></div></form></div>`;
 return appPage(`Record ${kind==='absence'?'Absence':'Sickness'}`,'Manager / Team Leader attendance record.',content,user,'Rota',db);
}

async function editAttendancePage(request,db,user,kind,id){
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 const table=kind==='absence'?'absences':'sickness';
 const item=await row(db,`SELECT x.*,e.display_name,e.team_id FROM ${table} x JOIN employees e ON e.id=x.employee_id WHERE x.id=? AND x.is_active=1`,id);
 if(!item)return errorPage(`${kind==='absence'?'Absence':'Sickness'} record not found.`,user,404);
 const types=kind==='absence'?await rows(db,'SELECT id,name FROM absence_types WHERE is_active=1 OR id=? ORDER BY name',item.absence_type_id):[];
 if(request.method.toUpperCase()==='POST'){
   const form=await request.formData(),action=String(form.get('action')||'save');
   if(action==='remove'){
     await db.prepare(`UPDATE ${table} SET is_active=0 WHERE id=?`).bind(id).run();
     await createNotification(db,item.employee_id,kind+'_removed',`${kind==='absence'?'Absence':'Sickness'} removed by ${user.display_name}`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}`,'/rota');
     return redirect(request,`/rota?week=${item.start_date}`);
   }
   const start=String(form.get('start_date')||''),end=String(form.get('end_date')||''),sp=String(form.get('start_portion')||'FULL'),ep=String(form.get('end_portion')||'FULL'),notes=String(form.get('notes')||'').trim()||null;
   if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start)return errorPage('Choose a valid date range.',user,400);
   if(kind==='absence'){const type=Number(form.get('absence_type_id'));await db.prepare('UPDATE absences SET absence_type_id=?,start_date=?,end_date=?,start_portion=?,end_portion=?,notes=? WHERE id=?').bind(type,start,end,sp,ep,notes,id).run();}
   else await db.prepare('UPDATE sickness SET start_date=?,end_date=?,start_portion=?,end_portion=?,notes=? WHERE id=?').bind(start,end,sp,ep,notes,id).run();
   await createNotification(db,item.employee_id,kind+'_modified',`${kind==='absence'?'Absence':'Sickness'} updated by ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}`,'/rota');
   return redirect(request,`/rota?week=${start}`);
 }
 const typeField=kind==='absence'?`<label>Absence Type<select name="absence_type_id" required>${types.map(t=>`<option value="${t.id}" ${Number(t.id)===Number(item.absence_type_id)?'selected':''}>${h(t.name)}</option>`).join('')}</select></label>`:'';
 const portion=(name,val)=>`<select name="${name}">${['FULL','AM','PM'].map(p=>`<option value="${p}" ${p===val?'selected':''}>${p}</option>`).join('')}</select>`;
 const content=`<div class="form-card"><h2>Edit ${kind==='absence'?'Absence':'Sickness'} · ${h(item.display_name)}</h2><form method="post">${typeField}<label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion>${portion('start_portion',item.start_portion)}</label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion>${portion('end_portion',item.end_portion)}</label><label>Notes <span class="muted">(optional)</span><textarea name="notes" rows="3">${h(item.notes||'')}</textarea></label><div class="action-bar"><button name="action" value="save">Save Changes</button><button name="action" value="remove" class="secondary" onclick="return confirm('Remove this record?')">Remove</button><a class="button secondary" href="/day?employee=${encodeURIComponent(item.display_name)}&date=${item.start_date}">Cancel</a></div></form></div>`;
 return appPage(`Edit ${kind==='absence'?'Absence':'Sickness'}`,'Manager / Team Leader attendance record.',content,user,'Rota',db);
}

async function shiftOverridePage(request,db,user){
 if(!(user.isManager||user.isTeamLeader))return accessPage('Access Denied','Manager or Team Leader access is required.',403);
 const url=new URL(request.url),employee=String(url.searchParams.get('employee')||''),date=String(url.searchParams.get('date')||'');
 const target=await row(db,'SELECT id,display_name FROM employees WHERE display_name=? AND is_active=1',employee);
 if(!target||!/^\d{4}-\d{2}-\d{2}$/.test(date))return errorPage('Invalid employee or date.',user,400);
 const existing=await row(db,'SELECT * FROM shift_overrides WHERE employee_id=? AND override_date=? AND is_active=1 ORDER BY id DESC LIMIT 1',target.id,date),shifts=await rows(db,'SELECT id,name,code,start_time,end_time FROM shift_types WHERE is_active=1 ORDER BY is_working_day,start_time,name');
 if(request.method.toUpperCase()==='POST'){
  const form=await request.formData(),action=String(form.get('action')||'save');
  if(action==='remove'&&existing){await db.prepare('UPDATE shift_overrides SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(existing.id).run();await createNotification(db,target.id,'shift_override_removed',`Shift override removed by ${user.display_name}`,date,'/rota');return redirect(request,`/rota?week=${date}`);}
  const sid=Number(form.get('shift_type_id')),notes=String(form.get('notes')||'').trim()||null;
  if(existing)await db.prepare('UPDATE shift_overrides SET shift_type_id=?,notes=?,recorded_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(sid,notes,user.id,existing.id).run();
  else await db.prepare('INSERT INTO shift_overrides(employee_id,override_date,shift_type_id,notes,recorded_by) VALUES(?,?,?,?,?)').bind(target.id,date,sid,notes,user.id).run();
  const chosen=shifts.find(s=>Number(s.id)===sid);await createNotification(db,target.id,'shift_override',`Shift changed by ${user.display_name}`,`${date} · ${chosen?.name||'Shift updated'}`,'/rota');return redirect(request,`/rota?week=${date}`);
 }
 const content=`<div class="form-card"><h2>${existing?'Change':'Add'} Shift Override · ${h(target.display_name)}</h2><p><strong>${h(date)}</strong></p><form method="post"><label>Effective Shift<select name="shift_type_id" required>${shifts.map(s=>`<option value="${s.id}" ${Number(s.id)===Number(existing?.shift_type_id)?'selected':''}>${h(s.name)} (${h(s.code)})${s.start_time?` · ${h(s.start_time)}–${h(s.end_time)}`:''}</option>`).join('')}</select></label><label>Notes <span class="muted">(optional)</span><textarea name="notes" rows="3">${h(existing?.notes||'')}</textarea></label><div class="action-bar"><button name="action" value="save">Save Override</button>${existing?`<button name="action" value="remove" class="secondary" onclick="return confirm('Remove this shift override and restore the rota pattern?')">Remove Override</button>`:''}<a class="button secondary" href="/day?employee=${encodeURIComponent(target.display_name)}&date=${date}">Cancel</a></div></form></div>`;
 return appPage('Shift Override','Change one day without altering the employee rota pattern.',content,user,'Rota',db);
}

async function dayActionsPage(request,db,user){
 const url=new URL(request.url),date=String(url.searchParams.get('date')||''),employee=String(url.searchParams.get('employee')||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return errorPage('Choose a valid date from the rota.',user,400);
 const target=await row(db,'SELECT id,display_name,team_id FROM employees WHERE display_name=? AND is_active=1 LIMIT 1',employee);
 if(!target)return errorPage('Employee not found.',user,404);
 const own=Number(target.id)===Number(user.id), elevated=user.isManager||user.isTeamLeader;
 if(!own&&!elevated)return accessPage('Access Denied','You cannot view day actions for another employee.',403);
 const leave=await row(db,"SELECT * FROM leave_requests WHERE employee_id=? AND start_date<=? AND end_date>=? AND status IN ('pending','approved') ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,id DESC LIMIT 1",target.id,date,date);
 const wfh=await row(db,"SELECT * FROM wfh_requests WHERE employee_id=? AND request_date=? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1",target.id,date);
 const absence=await row(db,"SELECT a.*,t.name type_name FROM absences a JOIN absence_types t ON t.id=a.absence_type_id WHERE a.employee_id=? AND a.is_active=1 AND a.start_date<=? AND a.end_date>=? ORDER BY a.id DESC LIMIT 1",target.id,date,date);
 const sickness=await row(db,"SELECT * FROM sickness WHERE employee_id=? AND is_active=1 AND start_date<=? AND end_date>=? ORDER BY id DESC LIMIT 1",target.id,date,date);
 const shiftOverride=await row(db,"SELECT o.*,s.name shift_name,s.code shift_code FROM shift_overrides o JOIN shift_types s ON s.id=o.shift_type_id WHERE o.employee_id=? AND o.override_date=? AND o.is_active=1 ORDER BY o.id DESC LIMIT 1",target.id,date);
 const gateTeam=await row(db,'SELECT gatekeeper_enabled FROM teams WHERE id=?',target.team_id),gatekeeper=gateTeam?.gatekeeper_enabled?await gatekeeperEffectiveFor(db,target.team_id,date):null,isWeekday=!([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())),targetIsGatekeeper=isWeekday&&gatekeeper&&Number(gatekeeper.employee_id)===Number(target.id);
 const oncall=await onCallEffectiveFor(db,date),targetIsOnCall=oncall&&Number(oncall.employee_id)===Number(target.id);
 let portion=null;if(leave){portion='FULL';if(date===leave.start_date)portion=leave.start_portion||'FULL';if(date===leave.end_date)portion=leave.end_portion||'FULL';}
 if(!own){
   let info=`<div class="card"><h2>${h(target.display_name)}</h2><p><strong>${h(date)}</strong></p>`;
   if(leave)info+=`<p><strong>Annual Leave:</strong> ${h(portion==='FULL'?'Full Day':portion+' half day')} · ${h(leave.status)}</p>`;
   if(wfh)info+=`<p><strong>WFH:</strong> ${h(wfh.status)}</p>`;
   if(absence)info+=`<p><strong>Absence:</strong> ${h(absence.type_name)} · ${h(absence.start_date)}${absence.end_date!==absence.start_date?` → ${h(absence.end_date)}`:''} <a href="/absence/${absence.id}/edit">Edit</a></p>`;
   if(sickness)info+=`<p><strong>Sickness:</strong> ${h(sickness.start_date)}${sickness.end_date!==sickness.start_date?` → ${h(sickness.end_date)}`:''} <a href="/sickness/${sickness.id}/edit">Edit</a></p>`;
   if(!leave&&!wfh&&!absence&&!sickness)info+='<p class="muted">No leave, WFH, absence or sickness activity recorded for this day.</p>';
   info+='</div>';
   if(user.isManager||user.isTeamLeader) info+=`<div class="card section-gap"><h2>Shift</h2>${shiftOverride?`<p><strong>Override:</strong> ${h(shiftOverride.shift_name)} (${h(shiftOverride.shift_code)})</p>`:''}<a class="button secondary" href="/shift-override?employee=${encodeURIComponent(target.display_name)}&date=${date}">${shiftOverride?'Change Override':'Change Shift'}</a></div>`;
   if(targetIsGatekeeper) info+=`<div class="card section-gap"><h2>Gatekeeper</h2><p><strong>${h(target.display_name)}</strong> is Gatekeeper for this day.</p><div class="action-bar">${own?`<a class="button secondary" href="/gatekeeper/cover?team=${target.team_id}&date=${date}&scope=day">Request Day Cover</a>`:''}${(user.isManager||user.isTeamLeader)?`<a class="button secondary" href="/gatekeeper/override?team=${target.team_id}&date=${date}&scope=day">Override Day</a>`:''}</div></div>`;
   if(targetIsOnCall) info+=`<div class="card section-gap"><h2>On Call</h2><p><strong>${h(target.display_name)}</strong> is On Call for this day.</p><div class="action-bar">${own?`<a class="button secondary" href="/on-call/cover?date=${date}&scope=day">Request Day Cover</a>`:''}${(user.isManager||user.isTeamLeader)?`<a class="button secondary" href="/on-call/override?date=${date}&scope=day">Override Day</a>`:''}</div></div>`;
   if(user.isManager||user.isTeamLeader) info+=`<div class="card section-gap"><h2>Attendance</h2><div class="action-bar"><a class="button" href="/absence/new?employee=${encodeURIComponent(target.display_name)}&date=${date}">Record Absence</a><a class="button secondary" href="/sickness/new?employee=${encodeURIComponent(target.display_name)}&date=${date}">Record Sickness</a></div></div>`;
   if(user.isManager&&user.managedTeamIds.includes(Number(target.team_id))){
     if(leave?.status==='approved')info+=`<div class="card section-gap"><h2>Manager Actions</h2><div class="action-bar"><a class="button secondary" href="/leave-requests/${leave.id}/edit">Modify Employee Leave</a><form method="post" action="/leave/${leave.id}/cancel"><button class="secondary">Cancel Leave</button></form></div></div>`;
     if(wfh&&['pending','approved'].includes(wfh.status))info+=`<div class="card section-gap"><h2>WFH</h2><div class="action-bar">${wfh.status==='pending'?`<a class="button" href="/wfh-requests/${wfh.id}">Review Request</a>`:''}<form method="post" action="/wfh/${wfh.id}/cancel"><button class="secondary">Cancel WFH</button></form></div></div>`;
   }
   return appPage('Day Actions',date,info+`<div class="section-gap"><a class="button secondary" href="/rota?week=${date}">Back to Rota</a></div>`,user,'Rota',db);
 }
 let actions='';
 if(targetIsGatekeeper) actions+=`<div class="card"><h2>Gatekeeper</h2><p>You are Gatekeeper for this day.</p><div class="action-bar"><a class="button secondary" href="/gatekeeper/cover?team=${target.team_id}&date=${date}&scope=day">Request Day Cover</a>${(user.isManager||user.isTeamLeader)?`<a class="button secondary" href="/gatekeeper/override?team=${target.team_id}&date=${date}&scope=day">Override Day</a>`:''}</div></div>`;
 if(targetIsOnCall) actions+=`<div class="card section-gap"><h2>On Call</h2><p>You are On Call for this day.</p><div class="action-bar"><a class="button secondary" href="/on-call/cover?date=${date}&scope=day">Request Day Cover</a>${(user.isManager||user.isTeamLeader)?`<a class="button secondary" href="/on-call/override?date=${date}&scope=day">Override Day</a>`:''}</div></div>`;
 if(leave){
   actions+=`<div class="card"><h2>Annual Leave · ${leave.status==='pending'?'Pending':'Approved'}</h2><p>${h(portion==='FULL'?'Full Day':portion+' half day')}</p><div class="action-bar">${leave.status==='pending'?`<a class="button" href="/leave/${leave.id}/edit">Edit Request</a><form method="post" action="/leave/${leave.id}/cancel"><button class="secondary">Withdraw</button></form>`:`<a class="button" href="/leave/${leave.id}/change">Request Modification</a><form method="post" action="/leave/${leave.id}/cancel"><button class="secondary">Cancel Leave</button></form>`}</div></div>`;
 } else actions+=`<div class="card"><h2>Annual Leave</h2><p>Request annual leave for this day.</p><div class="action-bar"><a class="button" href="/leave/quick?date=${date}&portion=FULL">Full Day</a><a class="button secondary" href="/leave/quick?date=${date}&portion=AM">AM</a><a class="button secondary" href="/leave/quick?date=${date}&portion=PM">PM</a></div></div>`;
 if(!wfh&&(!leave||portion!=='FULL'))actions+=`<div class="card section-gap"><h2>Working From Home</h2><p>Request to work from home for the working portion of this day.</p><a class="button secondary" href="/wfh/request?employee=${encodeURIComponent(user.display_name)}&date=${date}">${user.isManager?'Record WFH':'Request WFH'}</a></div>`;
 else if(wfh)actions+=`<div class="card section-gap"><h2>Working From Home</h2><p><strong>${wfh.status==='pending'?'WFH Requested':'WFH Approved'}</strong></p><form method="post" action="/wfh/${wfh.id}/cancel"><button class="secondary">${wfh.status==='pending'?'Withdraw WFH Request':'Cancel WFH'}</button></form></div>`;
 return appPage('Day Actions',date,actions+`<div class="section-gap"><a class="button secondary" href="/rota?week=${date}">Back to Rota</a></div>`,user,'Rota',db);
}

async function quickLeavePage(request,db,user){
 const url=new URL(request.url),date=String(url.searchParams.get('date')||''),portion=String(url.searchParams.get('portion')||'FULL').toUpperCase();
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['FULL','AM','PM'].includes(portion))return errorPage('Invalid quick leave request.',user,400);
 const clash=await row(db,"SELECT id FROM leave_requests WHERE employee_id=? AND start_date<=? AND end_date>=? AND status IN ('pending','approved')",user.id,date,date);
 if(clash)return redirect(request,`/day?employee=${encodeURIComponent(user.display_name)}&date=${date}`);
 if(request.method.toUpperCase()==='POST'){
   const form=await request.formData(),notes=String(form.get('employee_notes')||'').trim()||null,annualType=await row(db,"SELECT id FROM leave_types WHERE code='ANNUAL' LIMIT 1"),managerRecord=user.isManager;
   if(!annualType)return errorPage('Annual Leave type is not configured.',user,500);
   const made=await db.prepare("INSERT INTO leave_requests(employee_id,leave_type_id,start_date,end_date,start_portion,end_portion,status,employee_notes,reviewed_by,reviewed_at,manager_notes,entry_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(user.id,annualType.id,date,date,portion,portion,managerRecord?'approved':'pending',notes,managerRecord?user.id:null,managerRecord?new Date().toISOString():null,managerRecord?'Recorded directly by Manager':null,managerRecord?'MANAGER_RECORD':'REQUEST').run();
   if(!managerRecord){const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);for(const m of managers)await createNotification(db,m.id,'leave_request',`Annual leave request · ${user.display_name}`,`${date} ${portion}`,`/leave-requests/${Number(made.meta?.last_row_id)}`);}
   return redirect(request,`/rota?week=${date}`);
 }
 const label=portion==='FULL'?'Full Day':portion+' half day';
 const content=`<div class="form-card"><h2>${user.isManager?'Record Annual Leave':'Request Annual Leave'}</h2><p><strong>${h(date)}</strong> · ${h(label)}</p><form method="post"><label>Reason / Note <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">${user.isManager?'Record Leave':'Submit Request'}</button><a class="button secondary" href="/day?employee=${encodeURIComponent(user.display_name)}&date=${date}">Cancel</a></div></form></div>`;
 return appPage(user.isManager?'Record Annual Leave':'Request Annual Leave','Quick single-day request from the rota.',content,user,'Rota',db);
}

async function wfhRequestPage(request,db,user){
  const url=new URL(request.url),date=String(url.searchParams.get('date')||''),employee=String(url.searchParams.get('employee')||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return errorPage('Choose a valid date from the rota.',user,400);
  if(employee!==user.display_name)return errorPage('WFH requests can only be submitted from your own rota row.',user,403);
  const existing=await row(db,"SELECT id,status FROM wfh_requests WHERE employee_id=? AND request_date=? AND status IN ('pending','approved')",user.id,date);
  if(existing)return errorPage(`A WFH request already exists for ${date} (${existing.status}).`,user,400);
  const leave=await row(db,"SELECT start_date,end_date,start_portion,end_portion FROM leave_requests WHERE employee_id=? AND status='approved' AND start_date<=? AND end_date>=? ORDER BY id DESC LIMIT 1",user.id,date,date);
  if(leave){
    let portion='FULL';
    if(date===leave.start_date)portion=leave.start_portion||'FULL';
    if(date===leave.end_date)portion=leave.end_portion||'FULL';
    if(portion==='FULL')return errorPage('WFH cannot be requested on a full day of annual leave.',user,400);
  }
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),notes=String(form.get('employee_notes')||'').trim()||null,managerRecord=user.isManager;
    const made=await db.prepare("INSERT INTO wfh_requests(employee_id,request_date,status,employee_notes,reviewed_by,reviewed_at,manager_notes,entry_mode) VALUES(?,?,?,?,?,?,?,?)").bind(user.id,date,managerRecord?'approved':'pending',notes,managerRecord?user.id:null,managerRecord?new Date().toISOString():null,managerRecord?'Recorded directly by Manager':null,managerRecord?'MANAGER_RECORD':'REQUEST').run();
    if(!managerRecord){const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);for(const m of managers)await createNotification(db,m.id,'wfh_request',`WFH request · ${user.display_name}`,date,`/wfh-requests/${Number(made.meta?.last_row_id)}`);}
    return redirect(request,`/rota?week=${date}`);
  }
  const content=`<div class="form-card"><h2>${user.isManager?'Record WFH':'Request WFH'}</h2><p><strong>${h(date)}</strong></p>${user.isManager?'<p class="muted">Manager WFH is recorded directly as approved because authorisation takes place outside SupportApp.</p>':''}<form method="post"><label>Reason / Note <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">${user.isManager?'Record WFH':'Submit Request'}</button><a class="button secondary" href="/rota?week=${date}">Cancel</a></div></form></div>`;
  return appPage(user.isManager?'Record WFH':'Request WFH','Single-day working from home.',content,user,'Rota',db);
}

async function cancelWfh(request,db,user,id){
 const item=await row(db,`SELECT w.*,e.team_id,e.display_name FROM wfh_requests w JOIN employees e ON e.id=w.employee_id WHERE w.id=?`,id);
 if(!item)return errorPage('WFH request not found.',user,404);
 const own=Number(item.employee_id)===Number(user.id),managed=user.isManager&&user.managedTeamIds.includes(Number(item.team_id));
 if(!own&&!managed)return accessPage('Access Denied','You cannot cancel this WFH record.',403);
 if(!['pending','approved'].includes(item.status))return errorPage('This WFH record can no longer be cancelled.',user,400);
 await db.prepare("UPDATE wfh_requests SET status='cancelled',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?").bind(user.id,own?'Cancelled by employee':'Cancelled by Manager',id).run();
 if(own){
   const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,item.team_id,user.id);
   for(const m of managers)await createNotification(db,m.id,'wfh_cancelled',`WFH cancelled · ${item.display_name}`,item.request_date,'/wfh-requests');
 } else await createNotification(db,item.employee_id,'wfh_cancelled_manager',`WFH cancelled by ${user.display_name}`,item.request_date,'/rota');
 return redirect(request,own?`/rota?week=${item.request_date}`:'/wfh-requests');
}

async function wfhRequestsPage(request,db,user){
 const reqs=await rows(db,`SELECT w.*,e.display_name,t.name team_name FROM wfh_requests w JOIN employees e ON e.id=w.employee_id JOIN teams t ON t.id=e.team_id WHERE e.team_id IN (${user.managedTeamIds.map(()=>'?').join(',')||'NULL'}) ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END,w.request_date DESC`,...user.managedTeamIds);
 const table=reqs.length?`<table><thead><tr><th>Employee</th><th>Team</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody>${reqs.map(r=>`<tr><td><strong>${h(r.display_name)}</strong></td><td>${h(r.team_name)}</td><td>${h(r.request_date)}</td><td>${leaveStatus(r.status)}</td><td><a class="button secondary" href="/wfh-requests/${r.id}">${r.status==='pending'?'Review':'View'}</a></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No WFH requests.</div>';
 return appPage('WFH Requests','Review working from home requests for your managed teams.',`<div class="table-card">${table}</div>`,user,'WFH Requests',db);
}

async function wfhReviewPage(request,db,user,id){
 const item=await row(db,`SELECT w.*,e.display_name,e.team_id FROM wfh_requests w JOIN employees e ON e.id=w.employee_id WHERE w.id=?`,id);
 if(!item)return errorPage('WFH request not found.',user,404);
 if(!user.managedTeamIds.includes(Number(item.team_id)))return accessPage('Access Denied','This WFH request is outside your management scope.',403);
 if(request.method.toUpperCase()==='POST'&&item.status==='pending'){
   const form=await request.formData(),decision=String(form.get('decision')||'').toLowerCase(),notes=String(form.get('manager_notes')||'').trim()||null;
   if(!['approved','rejected'].includes(decision))return errorPage('Choose Approve or Reject.',user,400);
   await db.prepare('UPDATE wfh_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(decision,user.id,notes,id).run();
   await createNotification(db,item.employee_id,'wfh_review',`WFH request ${decision}`,`${item.request_date}${notes?` · ${notes}`:''}`,'/rota');
   return redirect(request,'/wfh-requests');
 }
 const managerCancel=['pending','approved'].includes(item.status)?`<form method="post" action="/wfh/${item.id}/cancel" class="section-gap"><button class="secondary">${item.status==='pending'?'Cancel Request':'Cancel WFH'}</button></form>`:'';
 const content=`<div class="card"><h2>${h(item.display_name)}</h2><p><strong>Date:</strong> ${h(item.request_date)}<br><strong>Status:</strong> ${h(item.status)}</p>${item.employee_notes?`<p><strong>Employee note:</strong><br>${h(item.employee_notes)}</p>`:''}</div>${managerCancel}${item.status==='pending'?`<div class="form-card section-gap"><h2>Review</h2><form method="post"><label>Manager Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3"></textarea></label><div class="action-bar"><button name="decision" value="approved">Approve</button><button name="decision" value="rejected" class="secondary">Decline</button></div></form></div>`:''}`;
 return appPage('Review WFH Request','Review a single-day WFH request.',content,user,'WFH Requests',db);
}

async function myLeavePage(request, db, user) {
  const method = request.method.toUpperCase();
  let message = '';
  if (method === 'POST') {
    const form = await request.formData();
    const startDate = String(form.get('start_date') || '').trim();
    const endDate = String(form.get('end_date') || '').trim();
    const notes = String(form.get('employee_notes') || '').trim() || null;
    const startPortion = String(form.get('start_portion') || 'FULL').toUpperCase();
    const endPortion = String(form.get('end_portion') || 'FULL').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      message = 'Start and end dates are required.';
    } else if (endDate < startDate) {
      message = 'End date cannot be before start date.';
    } else if (!['FULL','AM','PM'].includes(startPortion) || !['FULL','AM','PM'].includes(endPortion)) {
      message = 'Choose a valid full-day or half-day option.';
    } else if (startDate === endDate && startPortion !== 'FULL' && endPortion !== 'FULL' && startPortion !== endPortion) {
      message = 'For a single-day request choose Full Day, AM or PM consistently.';
    } else {
      const effectiveEndPortion = startDate === endDate ? startPortion : endPortion;
      const annualType = await row(db, "SELECT id FROM leave_types WHERE code='ANNUAL'");
      if (!annualType) return errorPage('Annual Leave is not configured.', user, 500);
      const managerRecord = user.isManager;
      const created = await db.prepare("INSERT INTO leave_requests (employee_id,leave_type_id,start_date,end_date,start_portion,end_portion,status,employee_notes,reviewed_by,reviewed_at,manager_notes,entry_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(user.id,annualType.id,startDate,endDate,startPortion,effectiveEndPortion,managerRecord?'approved':'pending',notes,managerRecord?user.id:null,managerRecord?new Date().toISOString():null,managerRecord?'Recorded directly by Manager':null,managerRecord?'MANAGER_RECORD':'REQUEST').run();
      const leaveId = Number(created.meta?.last_row_id);
      if (!managerRecord) {
        const managers = await rows(db, `SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id LEFT JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`, user.team_id,user.id);
        for (const manager of managers) await createNotification(db, manager.id, 'leave_request', `Annual leave request · ${user.display_name}`, `${startDate} ${startPortion}${endDate!==startDate?` → ${endDate} ${effectiveEndPortion}`:''}`, `/leave-requests/${leaveId}`);
      }
      return redirect(request, '/leave');
    }
  }

  const balance = await leaveBalance(db, user.id);
  const requests = await rows(db, `SELECT lr.*, reviewer.display_name AS reviewer_name FROM leave_requests lr LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE lr.employee_id=? ORDER BY lr.requested_at DESC,lr.id DESC`, user.id);
  const portionLabel = p => p === 'AM' ? 'AM' : p === 'PM' ? 'PM' : 'Full Day';
  const requestDates = r => r.start_date === r.end_date ? `${h(r.start_date)} <span class="muted">(${portionLabel(r.start_portion)})</span>` : `${h(r.start_date)} <span class="muted">(${portionLabel(r.start_portion)})</span> → ${h(r.end_date)} <span class="muted">(${portionLabel(r.end_portion)})</span>`;
  const today=new Date().toISOString().slice(0,10);
  const actions=r=>{ if(r.end_date<today)return '—'; if(r.status==='pending')return `<a class="button secondary" href="/leave/${r.id}/edit">Edit</a> <form method="post" action="/leave/${r.id}/cancel" style="display:inline"><button class="button secondary" type="submit">Withdraw</button></form>`; if(r.status==='approved'){const edit=user.isManager&&r.entry_mode==='MANAGER_RECORD'?`<a class="button secondary" href="/leave/${r.id}/edit">Edit</a> `:(!user.isManager?`<a class="button secondary" href="/leave/${r.id}/change">Request Change</a> `:'');return `${edit}<form method="post" action="/leave/${r.id}/cancel" style="display:inline"><button class="button secondary" type="submit">Cancel</button></form>`;} return '—';};
  const url=new URL(request.url), statusFilter=String(url.searchParams.get('status')||'all').toLowerCase(), hidePast=url.searchParams.get('past')!=='show', sort=String(url.searchParams.get('sort')||'newest');
  const filtered=requests.filter(r=>(statusFilter==='all'||r.status===statusFilter)&&(!hidePast||r.end_date>=today)).sort((a,b)=>(sort==='oldest'?1:-1)*String(a.start_date).localeCompare(String(b.start_date)));
  const filterBar=`<div class="card" style="padding:14px 18px;margin-bottom:16px"><form method="get" action="/leave" style="display:flex;gap:14px;align-items:end;flex-wrap:wrap"><label style="margin:0">Status<select name="status"><option value="all" ${statusFilter==='all'?'selected':''}>All statuses</option>${['pending','approved','rejected','cancelled'].map(s=>`<option value="${s}" ${statusFilter===s?'selected':''}>${s.replace(/^./,x=>x.toUpperCase())}</option>`).join('')}</select></label><label style="margin:0">Order<select name="sort"><option value="newest" ${sort==='newest'?'selected':''}>Newest leave first</option><option value="oldest" ${sort==='oldest'?'selected':''}>Oldest leave first</option></select></label><label style="margin:0;display:flex;align-items:center;gap:7px;padding-bottom:9px"><input type="checkbox" name="past" value="show" ${hidePast?'':'checked'} style="width:auto"> Show past leave</label><button type="submit" class="secondary">Apply Filters</button><a class="button secondary" href="/leave">Reset</a></form></div>`;
  const table = filtered.length ? `<table><thead><tr><th>Dates</th><th>Status</th><th>Notes</th><th>Requested</th><th>Reviewed By</th><th>Actions</th></tr></thead><tbody>${filtered.map((r) => `<tr><td><strong>${requestDates(r)}</strong></td><td>${leaveStatus(r.status)}</td><td>${h(r.employee_notes || '—')}</td><td>${h(String(r.requested_at || '').slice(0,16).replace('T',' '))}</td><td>${h(r.reviewer_name || '—')}</td><td>${actions(r)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No leave requests match the selected filters.</div>';
  const content = `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}${balanceCard(balance)}<div class="form-card section-gap"><h2>${user.isManager?'Record Annual Leave':'Request Annual Leave'}</h2>${user.isManager?'<p class="muted">Manager leave is recorded directly as approved because authorisation takes place outside SupportApp.</p>':''}<form method="post" action="/leave"><label>Start Date<input name="start_date" type="date" required></label><label>Start Portion<select name="start_portion"><option value="FULL">Full Day</option><option value="AM">AM (Half Day)</option><option value="PM">PM (Half Day)</option></select></label><label>End Date<input name="end_date" type="date" required></label><label>End Portion<select name="end_portion"><option value="FULL">Full Day</option><option value="AM">AM (Half Day)</option><option value="PM">PM (Half Day)</option></select></label><label>Notes <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">${user.isManager?'Record Leave':'Submit Request'}</button></div></form></div><div class="table-card section-gap"><h2>My Requests</h2>${filterBar}${table}</div>`;
  return appPage('My Leave', user.isManager ? 'Record approved annual leave and track your leave position.' : 'Request annual leave and track the status of your requests.', content, user, 'My Leave', db);
}

async function cancelOwnLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item) return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  if(item.end_date<today) return errorPage('Past leave cannot be changed through the normal leave workflow.',user,400);
  if(!['pending','approved'].includes(item.status)) return errorPage('Only pending or approved leave can be withdrawn or cancelled.',user,400);
  const wasPending=item.status==='pending';
  await db.prepare("UPDATE leave_requests SET status='cancelled', reviewed_by=?, reviewed_at=?, manager_notes=? WHERE id=?")
    .bind(user.id,new Date().toISOString(),wasPending?'Withdrawn by employee':'Cancelled by employee',id).run();
  if(!user.isManager){
    const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
    const action=wasPending?'withdrawn':'cancelled';
    for(const manager of managers) await createNotification(db,manager.id,`leave_${action}`,`Annual leave ${action} · ${user.display_name}`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}`,'/leave-requests');
  }
  return redirect(request,'/leave');
}

async function editOwnPendingLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item) return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  const direct=user.isManager && item.entry_mode==='MANAGER_RECORD' && item.end_date>=today;
  if(item.status!=='pending' && !direct) return errorPage('Only pending requests can be edited. Managers may also edit their own future recorded leave.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(), start=String(form.get('start_date')||''), end=String(form.get('end_date')||'');
    const sp=String(form.get('start_portion')||'FULL').toUpperCase(), ep=String(form.get('end_portion')||'FULL').toUpperCase(), notes=String(form.get('employee_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep)) return errorPage('Enter a valid leave period.',user,400);
    const effective=end===start?sp:ep;
    await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,employee_notes=? WHERE id=?').bind(start,end,sp,effective,notes,id).run();
    if(!direct){
      const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
      for(const manager of managers) await createNotification(db,manager.id,'leave_modified',`Pending leave updated · ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}`,`/leave-requests/${id}`);
    }
    return redirect(request,'/leave');
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const content=`<div class="form-card"><h2>${direct?'Edit Recorded Leave':'Edit Pending Leave'}</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Notes<textarea name="employee_notes" rows="3" maxlength="500">${h(item.employee_notes||'')}</textarea></label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/leave">Cancel</a></div></form></div>`;
  return appPage(direct?'Edit Recorded Leave':'Edit Pending Leave','Update the leave dates or half-day selection.',content,user,'My Leave',db);
}

async function changeOwnApprovedLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item)return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  if(item.status!=='approved'||item.end_date<today||user.isManager)return errorPage('Only future approved employee leave can be submitted for modification.',user,400);
  const existing=await row(db,"SELECT id FROM leave_change_requests WHERE leave_request_id=? AND status='pending'",id);
  if(existing)return errorPage('A modification request is already pending for this leave.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),start=String(form.get('start_date')||''),end=String(form.get('end_date')||''),sp=String(form.get('start_portion')||'FULL').toUpperCase(),ep=String(form.get('end_portion')||'FULL').toUpperCase(),notes=String(form.get('employee_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep))return errorPage('Enter a valid revised leave period.',user,400);
    const effective=end===start?sp:ep;
    const made=await db.prepare("INSERT INTO leave_change_requests (leave_request_id,employee_id,start_date,end_date,start_portion,end_portion,employee_notes) VALUES (?,?,?,?,?,?,?)").bind(id,user.id,start,end,sp,effective,notes).run();
    const changeId=Number(made.meta?.last_row_id);
    const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
    for(const m of managers)await createNotification(db,m.id,'leave_change_request',`Annual leave modification · ${user.display_name}`,`${item.start_date} → ${item.end_date} changed to ${start} → ${end}`,`/leave-changes/${changeId}`);
    return redirect(request,'/leave');
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const content=`<div class="card"><h2>Currently Approved</h2><p><strong>${h(item.start_date)}</strong> ${h(item.start_portion||'FULL')} → <strong>${h(item.end_date)}</strong> ${h(item.end_portion||'FULL')}</p><p class="muted">The existing booking remains on the rota until a Manager approves this change.</p></div><div class="form-card section-gap"><h2>Request Modification</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Reason / Note <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Request Change</button><a class="button secondary" href="/leave">Cancel</a></div></form></div>`;
  return appPage('Modify Annual Leave','Request a change to approved annual leave.',content,user,'My Leave',db);
}

async function managerEditEmployeeLeave(request,db,user,id){
  const item=await row(db,`SELECT lr.*,e.display_name,e.team_id FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE lr.id=?`,id);
  if(!item)return errorPage('Leave request not found.',user,404);
  if(!user.managedTeamIds.includes(Number(item.team_id)))return accessPage('Access Denied','This leave record is outside your management scope.',403);
  if(item.status!=='approved')return errorPage('Only approved leave can be modified through this Manager action.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),start=String(form.get('start_date')||''),end=String(form.get('end_date')||''),sp=String(form.get('start_portion')||'FULL').toUpperCase(),ep=String(form.get('end_portion')||'FULL').toUpperCase(),notes=String(form.get('manager_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep))return errorPage('Enter a valid revised leave period.',user,400);
    const effective=end===start?sp:ep;
    await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(start,end,sp,effective,user.id,notes||'Modified by Manager',id).run();
    await createNotification(db,item.employee_id,'leave_modified_manager',`Annual leave modified by ${user.display_name}`,`${item.start_date} → ${item.end_date} changed to ${start} → ${end}${notes?` · ${notes}`:''}`,'/leave');
    return redirect(request,`/leave-requests/${id}`);
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const historical=item.end_date<new Date().toISOString().slice(0,10);
  const content=`<div class="card"><h2>${h(item.display_name)}</h2><p><strong>Current record:</strong> ${h(item.start_date)} ${h(item.start_portion||'FULL')} → ${h(item.end_date)} ${h(item.end_portion||'FULL')}</p>${historical?'<div class="notice"><strong>Historical leave</strong><br>This change will retrospectively alter the employee’s leave record and entitlement calculation.</div>':''}</div><div class="form-card section-gap"><h2>Modify Employee Leave</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Reason / Note <span class="muted">(recommended)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Apply Change</button><a class="button secondary" href="/leave-requests/${id}">Cancel</a></div></form></div>`;
  return appPage('Modify Employee Leave','Managers can directly correct approved leave, including historical records.',content,user,'Leave Requests',db);
}

async function reviewLeaveChange(request,db,user,id){
  const ch=await row(db,`SELECT lc.*,lr.start_date AS old_start,lr.end_date AS old_end,lr.start_portion AS old_sp,lr.end_portion AS old_ep,e.display_name,e.team_id FROM leave_change_requests lc JOIN leave_requests lr ON lr.id=lc.leave_request_id JOIN employees e ON e.id=lc.employee_id WHERE lc.id=?`,id);
  if(!ch)return errorPage('Leave modification not found.',user,404);
  if(!user.managedTeamIds.includes(Number(ch.team_id)))return accessPage('Access Denied','This modification is outside your management scope.',403);
  if(request.method.toUpperCase()==='POST'){
    if(ch.status!=='pending')return redirect(request,`/leave-changes/${id}`);
    const form=await request.formData(),decision=String(form.get('decision')||'').toLowerCase(),notes=String(form.get('manager_notes')||'').trim()||null;
    if(!['approved','rejected'].includes(decision))return errorPage('Choose Approve or Reject.',user,400);
    if(decision==='approved')await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(ch.start_date,ch.end_date,ch.start_portion,ch.end_portion,user.id,notes,ch.leave_request_id).run();
    await db.prepare('UPDATE leave_change_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(decision,user.id,notes,id).run();
    await createNotification(db,ch.employee_id,'leave_change_review',`Annual leave modification ${decision}`,`${ch.start_date} → ${ch.end_date}${notes?` · ${notes}`:''}`,'/leave');
    return redirect(request,'/leave-requests');
  }
  const content=`<div class="card"><h2>${h(ch.display_name)}</h2><p><strong>Currently approved:</strong> ${h(ch.old_start)} ${h(ch.old_sp)} → ${h(ch.old_end)} ${h(ch.old_ep)}<br><strong>Requested:</strong> ${h(ch.start_date)} ${h(ch.start_portion)} → ${h(ch.end_date)} ${h(ch.end_portion)}</p>${ch.employee_notes?`<p><strong>Employee note:</strong><br>${h(ch.employee_notes)}</p>`:''}</div>${ch.status==='pending'?`<div class="form-card section-gap"><h2>Review Modification</h2><form method="post"><label>Manager Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3"></textarea></label><div class="action-bar"><button name="decision" value="approved">Approve Change</button><button name="decision" value="rejected" class="secondary">Reject Change</button></div></form></div>`:`<div class="notice section-gap"><strong>${h(ch.status)}</strong></div>`}`;
  return appPage('Review Leave Modification','Compare the approved booking with the requested change.',content,user,'Leave Requests',db);
}

async function leaveRequestsPage(request, db, user) {
  const scopeSql = ` AND e.team_id IN (${user.managedTeamIds.map(() => '?').join(',') || 'NULL'})`;
  const scopeParams = user.managedTeamIds;
  const requests = await rows(db, `SELECT lr.id,lr.start_date,lr.end_date,lr.start_portion,lr.end_portion,lr.status,lr.employee_notes,lr.requested_at,lr.manager_notes,e.display_name,t.name AS team_name,reviewer.display_name AS reviewer_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN teams t ON t.id=e.team_id LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE 1=1${scopeSql}`, ...scopeParams);
  const url=new URL(request.url), statusFilter=String(url.searchParams.get('status')||'all').toLowerCase(), hidePast=url.searchParams.get('past')!=='show', sort=String(url.searchParams.get('sort')||'newest'), today=new Date().toISOString().slice(0,10);
  const filtered=requests.filter(r=>(statusFilter==='all'||r.status===statusFilter)&&(!hidePast||r.end_date>=today)).sort((a,b)=>{if(a.status==='pending'&&b.status!=='pending')return -1;if(b.status==='pending'&&a.status!=='pending')return 1;return (sort==='oldest'?1:-1)*String(a.start_date).localeCompare(String(b.start_date));});
  const filterBar=`<div class="card" style="padding:14px 18px;margin-bottom:16px"><form method="get" action="/leave-requests" style="display:flex;gap:14px;align-items:end;flex-wrap:wrap"><label style="margin:0">Status<select name="status"><option value="all" ${statusFilter==='all'?'selected':''}>All statuses</option>${['pending','approved','rejected','cancelled'].map(s=>`<option value="${s}" ${statusFilter===s?'selected':''}>${s.replace(/^./,x=>x.toUpperCase())}</option>`).join('')}</select></label><label style="margin:0">Order<select name="sort"><option value="newest" ${sort==='newest'?'selected':''}>Newest leave first</option><option value="oldest" ${sort==='oldest'?'selected':''}>Oldest leave first</option></select></label><label style="margin:0;display:flex;align-items:center;gap:7px;padding-bottom:9px"><input type="checkbox" name="past" value="show" ${hidePast?'':'checked'} style="width:auto"> Show past leave</label><button type="submit" class="secondary">Apply Filters</button><a class="button secondary" href="/leave-requests">Reset</a></form></div>`;
  const table = filtered.length ? `<table><thead><tr><th>Employee</th><th>Team</th><th>Dates</th><th>Status</th><th>Employee Note</th><th></th></tr></thead><tbody>${filtered.map((r) => `<tr><td><strong>${h(r.display_name)}</strong></td><td>${h(r.team_name)}</td><td>${h(r.start_date)} ${h(r.start_portion==='FULL'?'Full Day':r.start_portion)}${r.end_date !== r.start_date ? ` → ${h(r.end_date)} ${h(r.end_portion==='FULL'?'Full Day':r.end_portion)}` : ''}</td><td>${leaveStatus(r.status)}</td><td>${h(r.employee_notes || '—')}</td><td><a class="button secondary" href="/leave-requests/${r.id}">${r.status === 'pending' ? 'Review' : 'View'}</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No leave requests match the selected filters.</div>';
  return appPage('Leave Requests', 'Review annual leave requests for employees in your managed teams.', `<div class="table-card">${filterBar}${table}</div>`, user, 'Leave Requests', db);
}

async function leaveRequestReviewPage(request, db, user, id) {
  const item = await row(db, `SELECT lr.*,e.display_name,e.team_id,t.name AS team_name,COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks,reviewer.display_name AS reviewer_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN teams t ON t.id=e.team_id LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE lr.id=?`, id);
  if (!item) return accessPage('Leave request not found', 'The requested leave request does not exist.', 404);
  if (!user.managedTeamIds.includes(Number(item.team_id))) return accessPage('Access Denied', 'This leave request is outside your management scope.', 403);

  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const decision = String(form.get('decision') || '').toLowerCase();
    const notes = String(form.get('manager_notes') || '').trim() || null;
    if (decision === 'cancelled') {
      if (item.status !== 'approved') return accessPage('Cannot cancel leave', 'Managers can cancel approved leave for employees in their managed teams, including historical leave.', 400);
      await db.prepare("UPDATE leave_requests SET status='cancelled',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=? AND status='approved'").bind(user.id,notes||'Cancelled by Manager',id).run();
      await createNotification(db,item.employee_id,'leave_cancelled_manager',`Annual leave cancelled by ${user.display_name}`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}${notes?` · ${notes}`:''}`,'/leave');
      return redirect(request,'/leave-requests');
    }
    if (item.status !== 'pending') return redirect(request, `/leave-requests/${id}`);
    if (!['approved','rejected'].includes(decision)) return accessPage('Invalid decision', 'Choose Approve or Reject.', 400);
    await db.prepare('UPDATE leave_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=? AND status=\'pending\'').bind(decision,user.id,notes,id).run();
    const verb = decision === 'approved' ? 'approved' : 'rejected';
    await createNotification(db, item.employee_id, 'leave_review', `Annual leave ${verb}`, `${item.start_date} ${item.start_portion||'FULL'}${item.end_date!==item.start_date?` → ${item.end_date} ${item.end_portion||'FULL'}`:''}${notes?` · ${notes}`:''}`, '/leave');
    return redirect(request, '/leave-requests');
  }

  const start = new Date(`${item.start_date}T00:00:00Z`), end = new Date(`${item.end_date}T00:00:00Z`);
  const assignments = item.pattern_id ? await rows(db, `SELECT rpw.week_number,wpd.day_of_week,st.code,st.name,st.is_working_day FROM rota_pattern_weeks rpw JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id JOIN shift_types st ON st.id=wpd.shift_type_id WHERE rpw.rota_pattern_id=?`, item.pattern_id) : [];
  const amap = new Map(assignments.map((a) => [`${a.week_number}:${a.day_of_week}`, a]));
  const rotaDays = [];
  for (let d = new Date(start); d <= end && rotaDays.length < 62; d.setUTCDate(d.getUTCDate()+1)) {
    let week=1;
    if(item.pattern_start_date && Number(item.cycle_length_weeks)>0){const ps=new Date(`${item.pattern_start_date}T00:00:00Z`); const dw=Math.floor((d-ps)/(7*86400000)); week=((dw%Number(item.cycle_length_weeks))+Number(item.cycle_length_weeks))%Number(item.cycle_length_weeks)+1;}
    const dow=(d.getUTCDay()+6)%7; const shift=amap.get(`${week}:${dow}`);
    const day=d.toISOString().slice(0,10); let portion='FULL';
    if(day===item.start_date) portion=item.start_portion||'FULL';
    if(day===item.end_date) portion=item.end_portion||'FULL';
    rotaDays.push({date:day,shift:shift?.code||'OFF',working:Boolean(shift?.is_working_day),portion});
  }
  const rotaTable = `<table><thead><tr><th>Date</th><th>Scheduled Shift</th><th>Leave Impact</th></tr></thead><tbody>${rotaDays.map((d)=>`<tr><td>${h(d.date)}</td><td>${h(d.shift)}</td><td>${d.working?`Working day → ${d.portion==='FULL'?'Full Day':d.portion+' Half Day'} Leave`:'Non-working day'}</td></tr>`).join('')}</tbody></table>`;
  const balance = await leaveBalance(db,item.employee_id);
  const requestCost = rotaDays.reduce((sum,d)=>sum+(d.working?(d.portion==='FULL'?1:0.5):0),0);
  const projected = balance ? balance.remaining - requestCost : null;
  const approvalWarning = item.status==='pending' && balance && projected < 0 ? `<div class="notice section-gap"><strong>⚠ Approval would create a negative balance</strong><br>This request uses ${requestCost.toFixed(1)} days. Current remaining balance is ${balance.remaining.toFixed(1)} days; after approval it would be ${projected.toFixed(1)} days. Approval is still permitted.</div>` : '';
  const today = new Date().toISOString().slice(0,10);
  const decision = item.status === 'pending' ? `<div class="form-card section-gap"><h2>Review</h2><form method="post"><label>Manager Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit" name="decision" value="approved">Approve</button><button type="submit" name="decision" value="rejected" class="secondary">Reject</button><a class="button secondary" href="/leave-requests">Cancel</a></div></form></div>` : `<div class="notice section-gap"><strong>${h(String(item.status).replace(/^./,x=>x.toUpperCase()))}</strong>${item.reviewer_name?` by ${h(item.reviewer_name)}`:''}${item.manager_notes?`<br>${h(item.manager_notes)}`:''}</div>${item.status==='approved'?`<div class="form-card section-gap"><h2>Manager Actions</h2><p><a class="button secondary" href="/leave-requests/${id}/edit">Modify Employee Leave</a></p><form method="post"><label>Reason / Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit" name="decision" value="cancelled" class="secondary">Cancel Employee Leave</button></div></form></div>`:''}`;
  const content = `<div class="card"><h2>${h(item.display_name)}</h2><p><strong>Team:</strong> ${h(item.team_name)}<br><strong>Requested:</strong> ${h(item.start_date)} ${h(item.start_portion==='FULL'?'Full Day':item.start_portion)}${item.end_date!==item.start_date?` → ${h(item.end_date)} ${h(item.end_portion==='FULL'?'Full Day':item.end_portion)}`:''}<br><strong>Status:</strong> ${leaveStatus(item.status)}</p>${item.employee_notes?`<p><strong>Employee note:</strong><br>${h(item.employee_notes)}</p>`:''}</div>${balanceCard(balance)}${approvalWarning}<div class="table-card section-gap"><h2>Scheduled Rota</h2>${rotaTable}</div>${decision}`;
  return appPage('Review Leave Request', 'Review the request against the employee’s scheduled rota.', content, user, 'Leave Requests', db);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const provider = String(env.AUTH_PROVIDER || 'bootstrap').trim().toLowerCase();
      const localAuth = provider === 'local';

      if (localAuth) {
        const authRoute = await localAuthRoutes(request, env.DB, path);
        if (authRoute) return authRoute;
      }

      const identity = await authenticate(request, env);
      if (!identity.authenticated) return localAuth ? redirect(request, '/login') : accessPage('Sign in required', identity.reason || 'Authentication is required.', 401);

      if (identity.bootstrap) return appWorker.fetch(withIdentityHeader(request, null), { ...env, AUTH_REQUIRED: 'false' });

      const user = await resolveUser(env.DB, identity);
      if (!user) {
        const supplied = identity.email || identity.username || 'the supplied identity';
        return accessPage('Access not provisioned', `You authenticated as ${supplied}, but no active SupportApp employee record matches that identity.`, 403);
      }

      if (localAuth && /^\/employees\/\d+\/password$/.test(path)) return passwordPage(request, env.DB, user, Number(path.split('/')[2]));

      if (path === '/api/notifications/unread-count' && request.method.toUpperCase() === 'GET') {
        const unread = await unreadCount(env.DB, user.id);
        return new Response(JSON.stringify({ unread }), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
      }

      if (path === '/notifications' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return notificationsPage(request, env.DB, user);
      if (/^\/notifications\/\d+$/.test(path) && request.method.toUpperCase() === 'GET') return notificationOpen(request, env.DB, user, Number(path.split('/')[2]));

      if (path==='/pdp/config' && request.method.toUpperCase()==='GET') return pdpConfigPage(env.DB,user);
      if (path==='/pdp/matrices/new' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return pdpMatrixPage(request,env.DB,user,null);
      if (/^\/pdp\/matrices\/\d+\/categories$/.test(path) && request.method.toUpperCase()==='POST') return pdpMatrixCategoryAction(request,env.DB,user,Number(path.split('/')[3]),null,'add');
      if (/^\/pdp\/matrices\/\d+\/skills$/.test(path) && request.method.toUpperCase()==='POST') return pdpMatrixSkillAction(request,env.DB,user,Number(path.split('/')[3]),null,'add');
      if (/^\/pdp\/matrices\/\d+\/skills\/\d+\/remove$/.test(path) && request.method.toUpperCase()==='POST') { const p=path.split('/'); return pdpMatrixSkillAction(request,env.DB,user,Number(p[3]),Number(p[5]),'remove'); }
      if (/^\/pdp\/matrices\/\d+\/skills\/\d+\/move$/.test(path) && request.method.toUpperCase()==='POST') { const p=path.split('/'); return pdpMatrixSkillAction(request,env.DB,user,Number(p[3]),Number(p[5]),'move'); }
      if (/^\/pdp\/matrices\/\d+\/categories\/\d+\/remove$/.test(path) && request.method.toUpperCase()==='POST') { const p=path.split('/'); return pdpMatrixCategoryAction(request,env.DB,user,Number(p[3]),Number(p[5]),'remove'); }
      if (/^\/pdp\/matrices\/\d+\/categories\/\d+\/move$/.test(path) && request.method.toUpperCase()==='POST') { const p=path.split('/'); return pdpMatrixCategoryAction(request,env.DB,user,Number(p[3]),Number(p[5]),'move'); }
      if (/^\/pdp\/matrices\/\d+\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return pdpMatrixPage(request,env.DB,user,Number(path.split('/')[3]));
      if (path==='/pdp/skills' && request.method.toUpperCase()==='POST') return pdpCreateSkill(request,env.DB,user);
      if (path==='/pdp/categories' && request.method.toUpperCase()==='POST') return pdpCreateCategory(request,env.DB,user);
      if (/^\/pdp\/ability\/[1-5]\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return pdpEditAbilityPage(request,env.DB,user,Number(path.split('/')[3]));
      if (/^\/pdp\/categories\/\d+\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return pdpEditCategoryPage(request,env.DB,user,Number(path.split('/')[3]));
      if (/^\/pdp\/skills\/\d+\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return pdpEditSkillPage(request,env.DB,user,Number(path.split('/')[3]));
      if (path==='/pdp/my-skills' && request.method.toUpperCase()==='GET') return pdpPlaceholder(user,'My Skills','Complete and review your PDP skills assessment.','PDP My Skills');
      if (path==='/pdp/team-skills' && request.method.toUpperCase()==='GET') return pdpPlaceholder(user,'Team Skills','Review skills assessments for employees in your management scope.','PDP Team Skills');
      if (path==='/gatekeepers' && request.method.toUpperCase()==='GET') return gatekeepersPage(request,env.DB,user);
      if (/^\/gatekeepers\/\d+\/member\/\d+\/move$/.test(path) && request.method.toUpperCase()==='POST') { const p=path.split('/'); return gatekeeperMove(request,env.DB,user,Number(p[2]),Number(p[4])); }
      if (/^\/gatekeepers\/\d+\/anchor$/.test(path) && request.method.toUpperCase()==='POST') return gatekeeperAnchor(request,env.DB,user,Number(path.split('/')[2]));
      if (path==='/gatekeeper/override' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return gatekeeperOverridePage(request,env.DB,user);
      if (path==='/gatekeeper/cover' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return gatekeeperCoverPage(request,env.DB,user);
      if (/^\/gatekeeper\/cover\/\d+$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return gatekeeperCoverReview(request,env.DB,user,Number(path.split('/')[3]));
      if (path==='/on-call/cover' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return onCallCoverPage(request,env.DB,user);
      if (/^\/on-call\/cover\/\d+$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return onCallCoverReview(request,env.DB,user,Number(path.split('/')[3]));
      if (path==='/on-call' && request.method.toUpperCase()==='GET') return onCallPage(request,env.DB,user);
      if (path==='/on-call/member/add' && request.method.toUpperCase()==='POST') return onCallMemberAction(request,env.DB,user,'add');
      if (/^\/on-call\/member\/\d+\/remove$/.test(path) && request.method.toUpperCase()==='POST') return onCallMemberAction(request,env.DB,user,'remove',Number(path.split('/')[3]));
      if (/^\/on-call\/member\/\d+\/move$/.test(path) && request.method.toUpperCase()==='POST') return onCallMove(request,env.DB,user,Number(path.split('/')[3]));
      if (path==='/on-call/anchor' && request.method.toUpperCase()==='POST') return onCallAnchor(request,env.DB,user);
      if (path==='/on-call/override' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return onCallOverridePage(request,env.DB,user);
      if (path === '/shift-override' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return shiftOverridePage(request,env.DB,user);
      if (/^\/absence\/\d+\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return editAttendancePage(request,env.DB,user,'absence',Number(path.split('/')[2]));
      if (/^\/sickness\/\d+\/edit$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return editAttendancePage(request,env.DB,user,'sickness',Number(path.split('/')[2]));
      if (path === '/absence/new' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return recordAttendancePage(request,env.DB,user,'absence');
      if (path === '/sickness/new' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return recordAttendancePage(request,env.DB,user,'sickness');
      if (path === '/day' && request.method.toUpperCase()==='GET') return dayActionsPage(request,env.DB,user);
      if (path === '/leave/quick' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return quickLeavePage(request,env.DB,user);
      if (/^\/wfh\/\d+\/cancel$/.test(path) && request.method.toUpperCase()==='POST') return cancelWfh(request,env.DB,user,Number(path.split('/')[2]));
      if (path === '/wfh/request' && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return wfhRequestPage(request,env.DB,user);
      if ((user.isManager || user.isSystemAdmin) && path === '/wfh-requests' && request.method.toUpperCase()==='GET') return wfhRequestsPage(request,env.DB,user);
      if ((user.isManager || user.isSystemAdmin) && /^\/wfh-requests\/\d+$/.test(path) && (request.method.toUpperCase()==='GET'||request.method.toUpperCase()==='POST')) return wfhReviewPage(request,env.DB,user,Number(path.split('/')[2]));

      if (path === '/leave' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return myLeavePage(request, env.DB, user);
      if (/^\/leave\/\d+\/cancel$/.test(path) && request.method.toUpperCase() === 'POST') return cancelOwnLeave(request, env.DB, user, Number(path.split('/')[2]));
      if (/^\/leave\/\d+\/change$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return changeOwnApprovedLeave(request, env.DB, user, Number(path.split('/')[2]));
      if ((user.isManager || user.isSystemAdmin) && /^\/leave-changes\/\d+$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return reviewLeaveChange(request, env.DB, user, Number(path.split('/')[2]));

      if (/^\/leave\/\d+\/edit$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return editOwnPendingLeave(request, env.DB, user, Number(path.split('/')[2]));


      if ((user.isManager || user.isSystemAdmin) && /^\/leave-requests\/\d+\/edit$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return managerEditEmployeeLeave(request, env.DB, user, Number(path.split('/')[2]));

      if ((user.isManager || user.isSystemAdmin) && path === '/leave-requests' && request.method.toUpperCase() === 'GET') return leaveRequestsPage(request, env.DB, user);
      if ((user.isManager || user.isSystemAdmin) && /^\/leave-requests\/\d+$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return leaveRequestReviewPage(request, env.DB, user, Number(path.split('/')[2]));

      const requestForApp = withIdentityHeader(request, user.email || identity.email || null);
      if (!user.isManager && !user.isSystemAdmin) {
        if (path === '/') return redirect(request, '/rota');
        if (!path.startsWith('/rota') && !path.startsWith('/wfh/') && !path.startsWith('/assets/')) return accessPage('Access Denied', 'Employees have rota access only.', 403);
      }

      if (user.isManager && !user.isSystemAdmin) {
        if (path === '/employees' || /^\/employees\/\d+\/edit$/.test(path)) return decorateResponse(await managerEmployees(request, env.DB, user), user, path, localAuth, env.DB);
        if (isManagerConfigPath(path)) return decorateResponse(await configWorker.fetch(requestForApp, env), user, path, localAuth, env.DB);
      }

      return decorateResponse(await appWorker.fetch(requestForApp, { ...env, AUTH_REQUIRED: 'true' }), user, path, localAuth, env.DB);
    } catch (error) {
      console.error(error);
      return accessPage('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
