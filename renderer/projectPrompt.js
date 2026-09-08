const input = document.getElementById('label-input');
const startBtn = document.getElementById('start-btn');
const cancelBtn = document.getElementById('cancel-btn');

function submit() {
  const value = input.value.trim();
  if (!value) {
    input.focus();
    return;
  }
  window.pochiProjectPrompt.submit(value);
}

startBtn.addEventListener('click', submit);
cancelBtn.addEventListener('click', () => window.pochiProjectPrompt.cancel());
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
  if (event.key === 'Escape') window.pochiProjectPrompt.cancel();
});
input.focus();
