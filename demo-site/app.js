// Demo-site behaviour (test fixture only).
// The "Alternate email" input is controlled: its value is kept in `state` and re-rendered from it,
// like a React controlled input. Setting `.value` without dispatching input/change does not stick.

(function () {
  const state = { altEmail: '' };
  const alt = document.getElementById('altEmail');
  const form = document.getElementById('profile-form');
  const status = document.getElementById('status');

  function render() {
    if (alt.value !== state.altEmail) alt.value = state.altEmail;
  }

  alt.addEventListener('input', (e) => {
    state.altEmail = e.target.value;
    render();
  });
  alt.addEventListener('change', (e) => {
    state.altEmail = e.target.value;
  });
  // Re-render on any interaction and periodically, so out-of-band value changes revert.
  form.addEventListener('input', render);
  form.addEventListener('focusout', render);
  setInterval(render, 150);

  document.getElementById('resetBtn').addEventListener('click', () => {
    form.reset();
    state.altEmail = '';
    render();
    status.hidden = true;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    status.hidden = false;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      status.className = 'status error';
      status.textContent = 'Please enter a valid email address.';
      return;
    }
    status.className = 'status ok';
    status.textContent = 'Profile saved successfully.';
  });
})();
