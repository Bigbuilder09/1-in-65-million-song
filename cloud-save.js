/* Authentication and revision-checked cloud saves. No analytics or paid functions. */
window.CloudSave = (() => {
  let auth, db, sdk, error = null, initialized = false;
  const configured = Boolean(window.FIREBASE_CONFIG?.apiKey && window.FIREBASE_CONFIG?.projectId);
  const api = {
    configured,
    get user() { return auth?.currentUser || null; },
    get error() { return error; },
    login() {
      if (location.protocol === 'file:') return Promise.reject(Object.assign(
        new Error('Open START-LOCAL.cmd to use Google Login'),
        { code: 'auth/operation-not-supported-in-this-environment' }
      ));
      // Open the popup in the click's activation context, without an async wait.
      // Preserve the original startup error instead of hiding it behind a generic one.
      if (!initialized) return Promise.reject(error || Object.assign(new Error('Firebase is still loading'), { code: 'firebase/loading' }));
      const provider = new sdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return sdk.signInWithPopup(auth, provider);
    },
    retry() { api.ready = initialize(); return api.ready; },
    async logout() { if (auth) await sdk.signOut(auth); },
    async list() {
      if (!api.user) return [];
      const result = await sdk.getDocs(sdk.collection(db, 'users', api.user.uid, 'characters'));
      return result.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    },
    async write(record) {
      if (!api.user) throw new Error('กรุณาเข้าสู่ระบบก่อน');
      const uid = api.user.uid;
      const ref = sdk.doc(db, 'users', uid, 'characters', record.id);
      return sdk.runTransaction(db, async tx => {
        const found = await tx.get(ref);
        const remote = found.exists() ? found.data() : null;
        if ((remote?.revision || 0) !== (record.cloudRevision || 0)) {
          return { conflict: { id: record.id, ...remote } };
        }
        if (api.user?.uid !== uid) throw new Error('บัญชีเปลี่ยนระหว่างบันทึก');
        const revision = (remote?.revision || 0) + 1;
        tx.set(ref, {
          engine: record.engine, payload: JSON.stringify(record.game),
          name: record.name, age: record.age, generation: record.generation,
          updatedAt: sdk.serverTimestamp(), revision,
        });
        return { revision };
      });
    },
  };
  async function initialize() {
    error = null;
    if (!configured) return;
    try {
      const version = '13.1.0';
      const [app, a, f] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`),
      ]);
      sdk = { ...a, ...f };
      const instance = app.getApps().length ? app.getApp() : app.initializeApp(window.FIREBASE_CONFIG);
      auth = a.getAuth(instance);
      db = f.getFirestore(instance);
      await auth.authStateReady();
      initialized = true;
    } catch (e) { error = e; console.warn('Firebase unavailable', e.code || e.message); }
  }
  api.ready = initialize();
  return api;
})();
