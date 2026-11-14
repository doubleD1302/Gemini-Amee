'use strict';
/**
 * Kiểm tra bản cập nhật (Giai đoạn 3, mục 7) — CHỈ khi người dùng bấm, không chạy nền.
 *  - Hỏi GitHub Releases API của repo công khai; không gửi dữ liệu nào về người dùng/project (chỉ User-Agent chung).
 *  - Ứng dụng KHÔNG tự tải hay chạy bất cứ file cài đặt nào (không tự cập nhật): chỉ báo có bản mới và mở TRANG phát hành
 *    trên GitHub bằng trình duyệt, nơi người dùng tự tải và kiểm tra. Tự cập nhật có chữ ký cần hạ tầng phát hành có ký (xem docs/PACKAGING.md).
 *  - Dữ liệu trả về là KHÔNG tin cậy: chỉ lấy tag_name (kiểm tra dạng semver) và html_url (phải thuộc đúng repo).
 */
const REPO = 'doubleD1302/Gemini-Amee';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const TIMEOUT_MS = 8000;

function parseVersion(v) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,30}))?(?:\+[0-9A-Za-z.-]{1,30})?$/.exec(String(v == null ? '' : v).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** >0 nếu a mới hơn b; <0 nếu cũ hơn; 0 nếu bằng; null nếu không phải semver. Bản tiền phát hành (-beta) cũ hơn bản chính thức cùng số. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** URL được phép mở: trang phát hành của đúng repo trên github.com. */
function safeReleaseUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' && u.hostname === 'github.com' && (u.pathname === `/${REPO}/releases` || u.pathname.startsWith(`/${REPO}/releases/`)) && !u.username && !u.password) return u.href;
  } catch { /* rơi xuống */ }
  return '';
}

/**
 * @param current phiên bản đang chạy
 * @param deps { fetchFn(url, opts) → Promise<{ok,status,json()}> }  (mặc định fetch toàn cục của Node/Electron)
 * @returns {{ status:'latest'|'update'|'unknown', current:string, latest:string, url:string, message:string }}
 */
async function checkForUpdate(current, deps = {}) {
  const fetchFn = deps.fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { status: 'unknown', current, latest: '', url: RELEASES_URL, message: 'Môi trường này không hỗ trợ kiểm tra cập nhật.' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), deps.timeoutMs || TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GeminiProjectStudio-UpdateCheck' }, signal: ctl ? ctl.signal : undefined, redirect: 'error' });
    if (res.status === 404) return { status: 'unknown', current, latest: '', url: RELEASES_URL, message: 'Repo chưa có bản phát hành nào.' };
    if (!res.ok) return { status: 'unknown', current, latest: '', url: RELEASES_URL, message: `GitHub trả về lỗi ${res.status}.` };
    const j = await res.json();
    const tag = j && typeof j.tag_name === 'string' ? j.tag_name : '';
    if (!parseVersion(tag)) return { status: 'unknown', current, latest: '', url: RELEASES_URL, message: 'Không đọc được số phiên bản của bản phát hành mới nhất.' };
    const url = safeReleaseUrl(j.html_url) || RELEASES_URL;
    const cmp = compareVersions(tag, current);
    if (cmp === null) return { status: 'unknown', current, latest: tag, url, message: 'Không so sánh được phiên bản.' };
    if (cmp > 0) return { status: 'update', current, latest: tag.replace(/^v/, ''), url, message: `Có bản mới ${tag.replace(/^v/, '')} (đang dùng ${current}). Mở trang phát hành để tải về — ứng dụng không tự tải hay cài đặt.` };
    return { status: 'latest', current, latest: tag.replace(/^v/, ''), url, message: `Bạn đang dùng bản mới nhất (${current}).` };
  } catch (err) {
    return { status: 'unknown', current, latest: '', url: RELEASES_URL, message: `Không kiểm tra được (${err && err.name === 'AbortError' ? 'quá thời gian' : err && err.message ? err.message : 'lỗi mạng'}).` };
  } finally { if (timer) clearTimeout(timer); }
}

module.exports = { checkForUpdate, compareVersions, parseVersion, safeReleaseUrl, REPO, API, RELEASES_URL };
