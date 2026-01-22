const form = document.getElementById("setup-form");
const passwordEl = document.getElementById("setup-password");
const confirmEl = document.getElementById("setup-confirm");
const messageEl = document.getElementById("setup-message");

function setMessage(text, isError = false) {
  if (!messageEl) return;
  messageEl.textContent = text;
  messageEl.classList.toggle("error", Boolean(isError));
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!passwordEl || !confirmEl) return;
  const password = passwordEl.value.trim();
  const confirm = confirmEl.value.trim();
  if (password.length < 8) {
    setMessage("Password must be at least 8 characters.", true);
    return;
  }
  if (password !== confirm) {
    setMessage("Passwords do not match.", true);
    return;
  }
  setMessage("Saving…");
  try {
    const res = await fetch("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.detail || "Setup failed.";
      setMessage(detail, true);
      return;
    }
    window.location.replace("/admin.html");
  } catch (err) {
    console.error(err);
    setMessage("Setup failed. Please try again.", true);
  }
}

if (form) {
  form.addEventListener("submit", handleSubmit);
}
