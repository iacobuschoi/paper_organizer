const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
const btn = form.querySelector('button');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: form.password.value }),
    });
    if (r.ok) return location.replace('/');
    const d = await r.json().catch(() => ({}));
    msg.textContent = d.error || `들어가지 못했어요 (${r.status})`;
    form.password.select();
  } catch (err) {
    msg.textContent = '서버에 닿지 않아요. 망 연결을 확인해 주세요.';
    console.warn('[login]', err);
  } finally {
    btn.disabled = false;
  }
});
