(() => {
  window.__starkPicker?.cleanup();
  const state = { active: true, pick: null, cleanup: null };
  window.__starkPicker = state;
  const overlay = document.createElement('div');
  const label = document.createElement('div');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid Highlight;box-sizing:border-box';
  label.style.cssText = 'position:absolute;left:0;bottom:100%;background:Highlight;color:HighlightText;font:12px sans-serif;padding:4px;white-space:nowrap';
  overlay.setAttribute('data-stark-picker-overlay', '');
  overlay.attachShadow({mode:'closed'}).append(label);
  document.documentElement.append(overlay);
  const short = (s, n) => String(s || '').slice(0, n);
  const selector = (el) => {
    const path = [];
    for (let node = el; node instanceof Element; node = node.parentElement) {
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        path.unshift('#' + CSS.escape(node.id)); break;
      }
      let part = node.tagName.toLowerCase() + Array.from(node.classList).slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName) : [node];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      path.unshift(part);
      if (document.querySelectorAll(path.join(' > ')).length === 1) break;
    }
    return path.join(' > ');
  };
  const visibleText = el => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const words = [];
    let length = 0;
    for (let node = walker.nextNode(); node && length < 200; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('input,textarea,script,style,[data-stark-picker-overlay]') || getComputedStyle(parent).visibility === 'hidden') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!range.getClientRects().length) continue;
      const word = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (word) { words.push(word); length += word.length + 1; }
    }
    return short(words.join(' '), 200);
  };
  const name = (el) => {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
    return short(el.getAttribute('aria-label') || labelled || Array.from(el.labels || []).map(l => l.textContent).join(' ') || el.getAttribute('alt') || visibleText(el) || el.getAttribute('title'), 200).trim();
  };
  const capture = (el) => {
    const r = el.getBoundingClientRect(), computed = getComputedStyle(el), styles = {}, attributes = {};
    for (const key of ['display','position','width','height','margin','padding','font-family','font-size','font-weight','line-height','color','background-color','border','border-radius','gap','opacity','z-index']) styles[key] = computed.getPropertyValue(key);
    for (const a of el.attributes) if (!(el.tagName === 'INPUT' && ['aria-valuenow','aria-valuetext'].includes(a.name)) && (['href','src','alt','name','type','placeholder'].includes(a.name) || a.name.startsWith('aria-'))) attributes[a.name] = short(a.value, 200);
    const clone = el.cloneNode(true);
    for (const node of clone.querySelectorAll('[data-stark-picker-overlay]')) node.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      node.removeAttribute('value');
      if (['INPUT','TEXTAREA'].includes(node.tagName)) {
        node.textContent = '';
        node.removeAttribute('aria-valuenow'); node.removeAttribute('aria-valuetext');
      }
      for (const a of Array.from(node.attributes)) if (a.value.length > 200) node.setAttribute(a.name, short(a.value, 200) + '…');
    }
    const tag = el.tagName.toLowerCase();
    return { selector: selector(el), tag, id: el.id, classes: Array.from(el.classList), role: el.getAttribute('role') || (tag === 'input' ? ({button:'button',submit:'button',reset:'button',checkbox:'checkbox',radio:'radio',range:'slider',number:'spinbutton',search:'searchbox'}[el.type] || 'textbox') : tag === 'a' && !el.hasAttribute('href') ? 'generic' : ({button:'button',a:'link',img:'img',select:'combobox',textarea:'textbox'}[tag] || tag)), accessible_name: name(el), text: visibleText(el), attributes, styles, bounds: {x:r.x,y:r.y,width:r.width,height:r.height}, url: location.href, title: document.title, viewport: {width:innerWidth,height:innerHeight}, device_pixel_ratio: devicePixelRatio, outer_html: short(clone.outerHTML,1500) };
  };
  const move = e => {
    if (!(e.target instanceof Element)) return;
    const el = e.target, r = el.getBoundingClientRect();
    Object.assign(overlay.style, {left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});
    label.textContent = el.tagName.toLowerCase() + Array.from(el.classList).slice(0,2).map(c => '.'+c).join('') + ' · ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    label.style.bottom = r.y < 30 ? 'auto' : '100%';
  };
  const events = ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu'];
  let finishing = false;
  const block = e => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type === 'click' && !finishing && e.target instanceof Element) {
      try { state.pick = capture(e.target); }
      finally { finishing = true; state.cleanup(); }
    }
  };
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); state.cleanup(); } };
  state.cleanup = () => {
    state.active = false; overlay.remove();
    window.removeEventListener('pointermove',move,true);
    window.removeEventListener('keydown',key,true);
    for (const event of events) window.removeEventListener(event,block,true);
  };
  window.addEventListener('pointermove',move,true);
  window.addEventListener('keydown',key,true);
  for (const event of events) window.addEventListener(event,block,true);
  return {active:true,pick:null};
})()
