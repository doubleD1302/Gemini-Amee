'use strict';
/* The extension NEVER reads Google cookies, localStorage, credentials, or internal Gemini APIs. */
async function getPairing() {
  const { pairing } = await chrome.storage.local.get('pairing');
  if (!pairing || typeof pairing.url !== 'string' || typeof pairing.token !== 'string') throw new Error('Chưa cấu hình pairing');
  const url = new URL(pairing.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port)) throw new Error('Bridge URL không hợp lệ');
  if (!/^[0-9a-f]{64}$/i.test(pairing.token)) throw new Error('Bridge token không hợp lệ');
  return { base: url.origin, token: pairing.token };
}
// Số giao thức khớp bridge.cjs (PROTOCOL). Studio dùng để cảnh báo extension cũ ở tab Bridge.
const GPS_PROTOCOL = 2;
async function request(endpoint, method='GET', body) {
  const { base, token } = await getPairing();
  const response = await fetch(base+endpoint, {
    method,
    headers: {'Authorization': `Bearer ${token}`, 'Content-Type':'application/json', 'X-GPS-Extension-Version': chrome.runtime.getManifest().version, 'X-GPS-Protocol': String(GPS_PROTOCOL)},
    ...(body===undefined ? {} : { body: JSON.stringify(body) }),
    cache:'no-store',
    signal:AbortSignal.timeout(7000)
  });
  if (!response.ok) {
    const json=await response.json().catch(()=>({}));
    throw new Error(json.error||`Bridge HTTP ${response.status}`);
  }
  return response.json();
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (!message || !['GPS_POLL','GPS_REPORT','GPS_PING','GPS_WRITE_FILE','GPS_GET_WORKSPACE'].includes(message.type)) return false;
  if (message.type!=='GPS_PING' && (!(sender.url || sender.tab?.url || '').startsWith('https://gemini.google.com/'))) {
    sendResponse({ error:'Only Gemini tabs can relay messages' });
    return false;
  }
  (async()=>{
    try {
      if (message.type==='GPS_POLL') return {data: await request('/v1/next')};
      if (message.type==='GPS_PING') return {data: {...(await request('/v1/health')), extensionVersion: chrome.runtime.getManifest().version, extensionProtocol: GPS_PROTOCOL}};
      if (message.type==='GPS_GET_WORKSPACE') return {data: await request('/v1/workspace')};
      if (message.type==='GPS_WRITE_FILE') {
        if (typeof message.path!=='string'||typeof message.content!=='string') throw new Error('Invalid file write payload');
        return {data:await request('/v1/write-file','POST',{path:message.path,content:message.content})};
      }
      if (message.type==='GPS_REPORT') {
        if (!['sent','streaming','final','error'].includes(message.status)) throw new Error('Invalid status');
        if (typeof message.id!=='string'||typeof message.text!=='string') throw new Error('Invalid job result');
        return {data:await request('/v1/result','POST',{id:message.id,status:message.status,text:message.text.slice(0,180000),conversationUrl:typeof message.conversationUrl==='string'?message.conversationUrl.slice(0,300):'',code:typeof message.code==='string'?message.code.slice(0,40):''})};
      }
    }catch(e){return {error:String(e.message||e)};}
  })().then(sendResponse).catch(e=>sendResponse({error:String(e)}));
  return true;
});
