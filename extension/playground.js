// playground.js — wires the "try it" page controls. The detection engine itself
// is the real content.js (loaded just before this script), so the playground
// shows the exact in-page experience users get on real sites.
'use strict';

// Clearly synthetic sample — never use realistic secrets here.
const SAMPLE_TEXT = [
  "Hi, I'm Jordan Avery — reach me at jordan.avery@example.com or +1 415-555-0142.",
  'My office is at 221 Baker Street, San Francisco.',
  'Test API key (fake): sk-proj-FAKE_TEST_DUMMY_000000000000000000000',
  'Card (fake): 4111 1111 1111 1111    SSN (fake): 123-45-6789',
].join('\n');

document.addEventListener('DOMContentLoaded', () => {
  const field = document.getElementById('playgroundInput');
  const insertBtn = document.getElementById('insertSampleBtn');
  const clearBtn = document.getElementById('clearBtn');
  if (!field) return;

  const fireInput = () => {
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };

  insertBtn?.addEventListener('click', () => {
    field.focus();
    field.textContent = SAMPLE_TEXT;
    // Move caret to the end so the editor state is consistent.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    fireInput();
  });

  clearBtn?.addEventListener('click', () => {
    field.textContent = '';
    field.focus();
    fireInput();
  });
});
