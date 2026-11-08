// window.pane is how this page talks to Pane and to the backend.
{{#backend}}const form = document.getElementById('greet');
const answer = document.getElementById('answer');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    answer.textContent = await pane.call('greet', form.who.value);
  } catch (err) {
    answer.textContent = err.message;
  }
});

pane.on('tick', (time) => {
  document.getElementById('clock').textContent = new Date(time).toLocaleTimeString();
});

{{/backend}}document.getElementById('open').addEventListener('click', () => {
  pane.window.open('about.html', { width: 440, height: 320 });
});
