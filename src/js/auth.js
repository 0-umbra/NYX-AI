import { initializeApp, getApp, getApps } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile
} from 'firebase/auth';

import { firebaseConfig } from './firebase-config.js';
import { toast } from './ui.js';

const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);

export async function getFirebaseIdToken() {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in to use cloud chat.');
  return user.getIdToken();
}

function friendlyError(error) {
  const messages = {
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/user-not-found': 'No account was found with this email.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account already exists with this email.',
    'auth/weak-password': 'Choose a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase.'
  };
  return messages[error?.code] || 'Authentication failed. Please try again.';
}

export function initAuth({ prefs, onSession, services = {
  observe: (next, error) => onAuthStateChanged(auth, next, error),
  signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
  create: (email, password) => createUserWithEmailAndPassword(auth, email, password),
  reset: (email) => sendPasswordResetEmail(auth, email),
  logout: () => signOut(auth),
} }) {
  const email = document.getElementById('account-email');
  const password = document.getElementById('account-password');
  const nameInput = document.getElementById('display-name');
  const signInButton = document.getElementById('account-signin');
  const createButton = document.getElementById('account-create');
  const resetButton = document.getElementById('account-reset');
  const logoutButton = document.getElementById('account-logout');

  const status = document.getElementById('acct-status');
  const emailLabel = document.getElementById('acct-email');
  const profileSub = document.querySelector('.profile-sub');

  const setBusy = (busy) => {
    [signInButton, createButton, resetButton, logoutButton]
      .filter(Boolean)
      .forEach(button => { button.disabled = busy; });
  };

  const showUser = (user) => {
    const fallback = prefs.get('displayName') ||
      user?.email?.split('@')[0] || 'Guest';
    const displayName = user?.displayName || fallback;
    const initial = (Array.from(displayName)[0] || 'G').toUpperCase();

    document.getElementById('acct-name').textContent = displayName;
    document.getElementById('acct-avatar').textContent = initial;
    document.getElementById('profile-name').textContent = displayName;
    document.getElementById('profile-avatar').textContent = initial;

    if (status) {
      status.textContent = user ? 'Signed in' : 'Guest mode';
      status.className = user ? 'badge' : 'badge badge-warn';
    }

    if (emailLabel) emailLabel.textContent = user?.email || '';
    if (profileSub) profileSub.textContent = user ? 'Signed in' : 'Not signed in';

    if (signInButton) signInButton.hidden = Boolean(user);
    if (createButton) createButton.hidden = Boolean(user);
    if (resetButton) resetButton.hidden = Boolean(user);
    if (logoutButton) logoutButton.hidden = !user;

    if (user && user.displayName && nameInput) {
      nameInput.value = user.displayName;
    }
  };

  const screen = document.getElementById('auth-screen');
  const app = document.getElementById('app');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const authError = document.getElementById('auth-error');
  const submit = document.getElementById('auth-submit');
  const loginTab = document.getElementById('auth-login-tab');
  const createTab = document.getElementById('auth-create-tab');
  let mode = 'login';
  const setError = (message) => { authError.textContent = message; authError.hidden = !message; };
  const setMode = (next) => {
    mode = next;
    loginTab.classList.toggle('is-active', mode === 'login');
    createTab.classList.toggle('is-active', mode === 'create');
    loginTab.setAttribute('aria-pressed', String(mode === 'login'));
    createTab.setAttribute('aria-pressed', String(mode === 'create'));
    submit.textContent = mode === 'login' ? 'Log In' : 'Create Account';
    authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    setError('');
  };
  loginTab.addEventListener('click', () => setMode('login'));
  createTab.addEventListener('click', () => setMode('create'));
  document.getElementById('auth-visibility').addEventListener('click', (event) => {
    const visible = authPassword.type === 'password';
    authPassword.type = visible ? 'text' : 'password';
    event.currentTarget.textContent = visible ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-pressed', String(visible));
  });
  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('');
    if (!authEmail.validity.valid || !authEmail.value.trim()) { setError('Enter a valid email address.'); return; }
    if (!authPassword.value) { setError('Enter your password.'); return; }
    if (mode === 'create' && authPassword.value.length < 6) { setError('Choose a password with at least 6 characters.'); return; }
    submit.disabled = true;
    try {
      if (mode === 'create') await services.create(authEmail.value.trim(), authPassword.value);
      else await services.signIn(authEmail.value.trim(), authPassword.value);
      authPassword.value = '';
    } catch (error) { setError(friendlyError(error)); }
    finally { submit.disabled = false; }
  });
  document.getElementById('auth-reset').addEventListener('click', async () => {
    if (!authEmail.value.trim() || !authEmail.validity.valid) { setError('Enter a valid email address first.'); return; }
    try { await services.reset(authEmail.value.trim()); setError(''); toast('Password reset email sent.'); }
    catch (error) { setError(friendlyError(error)); }
  });
  services.observe((user) => {
      showUser(user);
      document.getElementById('auth-loading').hidden = true;
      document.getElementById('auth-content').hidden = false;
      screen.hidden = Boolean(user);
      app.hidden = !user;
      authPassword.value = '';
      onSession?.(user);
    }, () => {
      document.getElementById('auth-loading').hidden = true;
      document.getElementById('auth-content').hidden = false;
      screen.hidden = false; app.hidden = true;
      setError('Unable to restore your session. Please sign in again.');
      onSession?.(null);
    });

  signInButton?.addEventListener('click', async () => {
    if (!email.value.trim() || !password.value) {
      toast('Enter your email and password.');
      return;
    }

    setBusy(true);
    try {
      await services.signIn(email.value.trim(), password.value);
      password.value = '';
      toast('Signed in successfully.');
    } catch (error) {
      toast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  createButton?.addEventListener('click', async () => {
    if (!email.value.trim() || !password.value) {
      toast('Enter your email and password.');
      return;
    }

    if (password.value.length < 6) {
      toast('Password must contain at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      const credential = await services.create(email.value.trim(), password.value);

      const displayName = nameInput?.value.trim();
      if (displayName) {
        await updateProfile(credential.user, { displayName });
      }

      password.value = '';
      toast('Your NYX account has been created.');
    } catch (error) {
      toast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  resetButton?.addEventListener('click', async () => {
    if (!email.value.trim()) {
      toast('Enter your email address first.');
      return;
    }

    setBusy(true);
    try {
      await services.reset(email.value.trim());
      toast('Password reset email sent.');
    } catch (error) {
      toast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  logoutButton?.addEventListener('click', async () => {
    setBusy(true);
    try {
      await services.logout();
      toast('Signed out. Your local conversations remain on this device.');
    } catch (error) {
      toast(friendlyError(error));
    } finally {
      setBusy(false);
    }
  });

  nameInput?.addEventListener('change', async () => {
    const user = auth.currentUser;
    const displayName = nameInput.value.trim().slice(0, 32);

    if (user && displayName) {
      try {
        await updateProfile(user, { displayName });
        showUser(user);
      } catch {
        toast('Could not update your account name.');
      }
    }
  });
}
