///////////////////////////////////////////////////////////////////////////
// firebase.js
//  Initializes Firebase (Auth + Firestore) and exposes small helper
//  functions for the rest of the app. Nothing outside this file imports
//  from the Firebase SDK directly, so an SDK change only touches this file.
//
//  The SDK is loaded from Firebase's CDN as ES modules (the project has no
//  bundler). This app shares the AI Document Reader's Firebase project, so
//  students keep one login; its collections are prefixed "essay" so they
//  can't collide with the Reader's "documents" and "shares".
//
//  Data model (see Architecture section 5):
//    essayTemplates/{templateId}
//      sources/{sourceId}/pages/{n}, sources/{sourceId}/vectors/{n}
//    essayDocuments/{docId}
//      sources/{sourceId}/pages/{n}, sources/{sourceId}/vectors/{n}
//      analyses/{analysisId}
//      snapshots/{snapshotId}
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// A public client identifier, not a secret. Security comes from the
// Firestore security rules and the Auth providers enabled in the console.
// Same project as the Reader.
const firebaseConfig = {
  apiKey: "AIzaSyBmXd1hBW_pMIYG2QqGvyB9SkabHuGny3Y",
  authDomain: "ai-document-reader-901ba.firebaseapp.com",
  projectId: "ai-document-reader-901ba",
  storageBucket: "ai-document-reader-901ba.firebasestorage.app",
  messagingSenderId: "885098590654",
  appId: "1:885098590654:web:925af3e13b56992d0509ef",
  measurementId: "G-V6GTNBWFY9"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

///////////////////////////////////////////////////////////////////////////
// Auth helpers
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: signUpEmail
//  Inputs: email, password
//  Outputs: Promise<User> — the newly created user
///////////////////////////////////////////////////////////////////////////
async function signUpEmail(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signInEmail
//  Inputs: email, password
//  Outputs: Promise<User> — the signed-in user
///////////////////////////////////////////////////////////////////////////
async function signInEmail(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signInGoogle
//  Inputs: None
//  Outputs: Promise<User> — the signed-in user
//  Summary: Signs in through a Google popup.
///////////////////////////////////////////////////////////////////////////
async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

///////////////////////////////////////////////////////////////////////////
//  Function: signOutUser
//  Inputs: None
//  Outputs: Promise — resolves when signed out
///////////////////////////////////////////////////////////////////////////
function signOutUser() {
  return signOut(auth);
}

///////////////////////////////////////////////////////////////////////////
//  Function: onAuthChange
//  Inputs: callback(user) — user is null when signed out
//  Outputs: Returns the unsubscribe function
//  Summary: Calls the callback once with the current auth state as soon as
//    Firebase has worked it out, and again on every sign-in and sign-out.
///////////////////////////////////////////////////////////////////////////
function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

///////////////////////////////////////////////////////////////////////////
//  Function: getIdToken
//  Inputs: forceRefresh (boolean, default false)
//  Outputs: Promise<string> — an ID token for the signed-in user
//  Summary: Sent to the AI worker (see api.js), which verifies it. The SDK
//    refreshes an expired token by itself; forceRefresh is for the retry
//    after a 401 (Phase 2).
///////////////////////////////////////////////////////////////////////////
function getIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) return Promise.reject(new Error("Not signed in"));
  return user.getIdToken(forceRefresh);
}

///////////////////////////////////////////////////////////////////////////
// Shared helpers
//  Firestore doesn't delete a document's subcollections when the document
//  is deleted, so the delete helpers below remove them explicitly. They run
//  BEFORE the parent is deleted, because the security rules for a
//  subcollection look at the parent document's ownerId: once the parent is
//  gone, the rules would refuse the subcollection deletes.
//
//  Every update below uses updateDoc, not setDoc with merge. A merge write
//  combines nested maps (so a removed key in outlineAnswers would survive);
//  updateDoc replaces each top-level field you pass, which is what saving a
//  whole document needs.
///////////////////////////////////////////////////////////////////////////

const TEMPLATES_COLLECTION = "essayTemplates";
const DOCUMENTS_COLLECTION = "essayDocuments";

// "template" and "document" are the two things that can own sources.
const PARENT_COLLECTIONS = {
  template: TEMPLATES_COLLECTION,
  document: DOCUMENTS_COLLECTION
};

// A Firestore batch holds at most 500 writes; stay safely under.
const BATCH_CHUNK_SIZE = 400;

///////////////////////////////////////////////////////////////////////////
//  Function: serverNow
//  Inputs: None
//  Outputs: A server-timestamp placeholder for use in commitBatch data
///////////////////////////////////////////////////////////////////////////
function serverNow() {
  return serverTimestamp();
}

///////////////////////////////////////////////////////////////////////////
//  Function: parentCollectionName
//  Inputs: parentKind ("template" | "document")
//  Outputs: The top-level collection name (throws on an unknown kind)
///////////////////////////////////////////////////////////////////////////
function parentCollectionName(parentKind) {
  const name = PARENT_COLLECTIONS[parentKind];
  if (!name) throw new Error(`Unknown parent kind "${parentKind}"`);
  return name;
}

///////////////////////////////////////////////////////////////////////////
//  Function: withoutProtectedFields
//  Inputs: data (an object of fields to save)
//  Outputs: A copy without ownerId, createdAt, and revision
//  Summary: Saves must never change who owns a record or when it was
//    created, and revision is only changed by saveDocumentWithRevision. The
//    security rules also forbid changing ownerId.
///////////////////////////////////////////////////////////////////////////
function withoutProtectedFields(data) {
  const { ownerId, createdAt, revision, ...safe } = data || {};
  return safe;
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteRefs
//  Inputs: refs (an array of document references)
//  Outputs: Promise — resolves when every one is deleted, in batches
///////////////////////////////////////////////////////////////////////////
async function deleteRefs(refs) {
  for (let i = 0; i < refs.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    refs.slice(i, i + BATCH_CHUNK_SIZE).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteWholeCollection
//  Inputs: collectionRef
//  Outputs: Promise — resolves when every document in it is deleted
///////////////////////////////////////////////////////////////////////////
async function deleteWholeCollection(collectionRef) {
  const snap = await getDocs(collectionRef);
  await deleteRefs(snap.docs.map(d => d.ref));
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteAllSources
//  Inputs: parentKind, parentId
//  Outputs: Promise — deletes every source of the parent, including each
//    source's pages and vectors
///////////////////////////////////////////////////////////////////////////
async function deleteAllSources(parentKind, parentId) {
  const sourcesRef = collection(db, parentCollectionName(parentKind), parentId, "sources");
  const snap = await getDocs(sourcesRef);

  for (const sourceDoc of snap.docs) {
    await deleteWholeCollection(collection(sourceDoc.ref, "pages"));
    await deleteWholeCollection(collection(sourceDoc.ref, "vectors"));
    await deleteDoc(sourceDoc.ref);
  }
}

///////////////////////////////////////////////////////////////////////////
//  Function: commitBatch
//  Inputs: operations — an array of
//    { type: "set" | "update" | "delete", path: [segment, ...], data?, merge? }
//    where path is the document's path as segments, for example
//    ["essayDocuments", docId, "snapshots", snapshotId]
//  Outputs: Promise — resolves when all the writes have been committed
//    together (all succeed or none do)
//  Summary: For the few places that must change several documents
//    atomically, such as Progress to Revision Stage (Phase 6), which writes a
//    snapshot and updates the document in one commit. Use serverNow() for
//    timestamp fields. At most 500 operations.
///////////////////////////////////////////////////////////////////////////
async function commitBatch(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return;
  if (operations.length > 500) throw new Error("A batch can hold at most 500 operations");

  const batch = writeBatch(db);

  operations.forEach(op => {
    const ref = doc(db, ...op.path);
    if (op.type === "set") {
      if (op.merge) batch.set(ref, op.data, { merge: true });
      else batch.set(ref, op.data);
    } else if (op.type === "update") {
      batch.update(ref, op.data);
    } else if (op.type === "delete") {
      batch.delete(ref);
    } else {
      throw new Error(`Unknown batch operation type "${op.type}"`);
    }
  });

  await batch.commit();
}

///////////////////////////////////////////////////////////////////////////
// Template helpers
//  A template is an ordered list of outline sections (see Architecture 5).
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: templateDefaults
//  Inputs: None
//  Outputs: A fresh object with every template field set to an empty value
///////////////////////////////////////////////////////////////////////////
function templateDefaults() {
  return {
    title: "Untitled template",
    answers: { about: "", prompt: "", requirements: "" },
    sections: [],
    changes: [],
    hasPacket: false
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: createTemplateRecord
//  Inputs: ownerId (user uid), data (the template's fields: title, themeId,
//    category, answers, sections, changes, hasPacket)
//  Outputs: Promise<string> — the new template's id
//  Summary: Fields not given are filled in from templateDefaults().
///////////////////////////////////////////////////////////////////////////
async function createTemplateRecord(ownerId, data = {}) {
  const ref = await addDoc(collection(db, TEMPLATES_COLLECTION), {
    ...templateDefaults(),
    ...withoutProtectedFields(data),
    ownerId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveTemplateRecord
//  Inputs: templateId, data (the fields to save)
//  Outputs: Promise — resolves when saved
//  Summary: Replaces each field given and updates updatedAt.
///////////////////////////////////////////////////////////////////////////
async function saveTemplateRecord(templateId, data) {
  await updateDoc(doc(db, TEMPLATES_COLLECTION, templateId), {
    ...withoutProtectedFields(data),
    updatedAt: serverTimestamp()
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: renameTemplateRecord
//  Inputs: templateId, title
//  Outputs: Promise — resolves when renamed
//  Summary: Changes only the title, leaving updatedAt alone so renaming
//    doesn't reorder the home screen list.
///////////////////////////////////////////////////////////////////////////
async function renameTemplateRecord(templateId, title) {
  await updateDoc(doc(db, TEMPLATES_COLLECTION, templateId), { title });
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteTemplateRecord
//  Inputs: templateId
//  Outputs: Promise — resolves when the template and its sources are gone
///////////////////////////////////////////////////////////////////////////
async function deleteTemplateRecord(templateId) {
  await deleteAllSources("template", templateId);
  await deleteDoc(doc(db, TEMPLATES_COLLECTION, templateId));
}

///////////////////////////////////////////////////////////////////////////
//  Function: getTemplateRecord
//  Inputs: templateId
//  Outputs: Promise<object | null> — { id, ...fields }, or null if it
//    doesn't exist
///////////////////////////////////////////////////////////////////////////
async function getTemplateRecord(templateId) {
  const snap = await getDoc(doc(db, TEMPLATES_COLLECTION, templateId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

///////////////////////////////////////////////////////////////////////////
//  Function: listUserTemplates
//  Inputs: ownerId (user uid)
//  Outputs: Promise<object[]> — the user's templates, most recently
//    updated first
//  Summary: Needs a Firestore index on (ownerId, updatedAt). The first time
//    it runs, the console shows an error with a link that creates it.
///////////////////////////////////////////////////////////////////////////
async function listUserTemplates(ownerId) {
  const q = query(
    collection(db, TEMPLATES_COLLECTION),
    where("ownerId", "==", ownerId),
    orderBy("updatedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

///////////////////////////////////////////////////////////////////////////
// Document helpers
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: documentDefaults
//  Inputs: None
//  Outputs: A fresh object with every document field set to an empty value
//  Summary: A new document starts in the "drafting" stage with revision 0
//    and no template.
///////////////////////////////////////////////////////////////////////////
function documentDefaults() {
  return {
    title: "Untitled document",
    stage: "drafting",
    revision: 0,
    mainHtml: "",
    template: null,
    outlineAnswers: {},
    tabs: [],
    format: {
      styleId: "mla",
      details: { title: "", studentName: "", instructor: "", course: "", institution: "", date: "" }
    }
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: createDocumentRecord
//  Inputs: ownerId (user uid), data (any document fields to start with)
//  Outputs: Promise<string> — the new document's id
//  Summary: Fields not given are filled in from documentDefaults(). Unlike
//    the other fields, revision always starts at 0.
///////////////////////////////////////////////////////////////////////////
async function createDocumentRecord(ownerId, data = {}) {
  const ref = await addDoc(collection(db, DOCUMENTS_COLLECTION), {
    ...documentDefaults(),
    ...withoutProtectedFields(data),
    revision: 0,
    ownerId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveDocumentRecord
//  Inputs: docId, data (the fields to save)
//  Outputs: Promise — resolves when saved
//  Summary: A plain save that does NOT check or change revision. Use it for
//    changes that can't conflict. Saving the essay itself goes through
//    saveDocumentWithRevision.
///////////////////////////////////////////////////////////////////////////
async function saveDocumentRecord(docId, data) {
  await updateDoc(doc(db, DOCUMENTS_COLLECTION, docId), {
    ...withoutProtectedFields(data),
    updatedAt: serverTimestamp()
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveDocumentWithRevision
//  Inputs: docId, expectedRevision (the revision this device last loaded or
//    saved), data (the fields to save)
//  Outputs: Promise<number> — the new revision. Rejects with
//    error.code === "revision-conflict" (and error.currentRevision) if
//    another device saved in between, or "not-found" if the document is gone.
//  Summary: Runs in a transaction, so the check and the write can't be
//    separated by another device's save. Phase 5's conflict dialog builds on
//    this. A transaction needs a connection; when offline it rejects, and
//    the autosave module keeps the local backup.
///////////////////////////////////////////////////////////////////////////
async function saveDocumentWithRevision(docId, expectedRevision, data) {
  const ref = doc(db, DOCUMENTS_COLLECTION, docId);

  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(ref);

    if (!snap.exists()) {
      const err = new Error("The document no longer exists.");
      err.code = "not-found";
      throw err;
    }

    const currentRevision = snap.data().revision ?? 0;
    if (currentRevision !== expectedRevision) {
      const err = new Error("The document was changed on another device.");
      err.code = "revision-conflict";
      err.currentRevision = currentRevision;
      throw err;
    }

    const nextRevision = currentRevision + 1;
    transaction.update(ref, {
      ...withoutProtectedFields(data),
      revision: nextRevision,
      updatedAt: serverTimestamp()
    });
    return nextRevision;
  });
}

///////////////////////////////////////////////////////////////////////////
//  Function: renameDocumentRecord
//  Inputs: docId, title
//  Outputs: Promise — resolves when renamed
//  Summary: Changes only the title, leaving updatedAt and revision alone, so
//    renaming from the home screen doesn't reorder the list or cause a
//    conflict on another device.
///////////////////////////////////////////////////////////////////////////
async function renameDocumentRecord(docId, title) {
  await updateDoc(doc(db, DOCUMENTS_COLLECTION, docId), { title });
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteDocumentRecord
//  Inputs: docId
//  Outputs: Promise — resolves when the document and everything under it
//    (sources, analyses, snapshots) is permanently deleted
///////////////////////////////////////////////////////////////////////////
async function deleteDocumentRecord(docId) {
  await deleteAllSources("document", docId);
  await deleteWholeCollection(collection(db, DOCUMENTS_COLLECTION, docId, "analyses"));
  await deleteWholeCollection(collection(db, DOCUMENTS_COLLECTION, docId, "snapshots"));
  await deleteDoc(doc(db, DOCUMENTS_COLLECTION, docId));
}

///////////////////////////////////////////////////////////////////////////
//  Function: getDocumentRecord
//  Inputs: docId
//  Outputs: Promise<object | null> — { id, ...fields }, or null if it
//    doesn't exist
///////////////////////////////////////////////////////////////////////////
async function getDocumentRecord(docId) {
  const snap = await getDoc(doc(db, DOCUMENTS_COLLECTION, docId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

///////////////////////////////////////////////////////////////////////////
//  Function: listUserDocuments
//  Inputs: ownerId (user uid)
//  Outputs: Promise<object[]> — the user's documents, most recently
//    updated first
//  Summary: Like listUserTemplates, needs an (ownerId, updatedAt) index.
///////////////////////////////////////////////////////////////////////////
async function listUserDocuments(ownerId) {
  const q = query(
    collection(db, DOCUMENTS_COLLECTION),
    where("ownerId", "==", ownerId),
    orderBy("updatedAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

///////////////////////////////////////////////////////////////////////////
// Source helpers
//  A source is an uploaded file's extracted text. Sources live under a
//  template (a DBQ packet) or a document (Material tab), in the same shape:
//    sources/{sourceId}          metadata (name, kind, pageCount, ...)
//    sources/{sourceId}/pages/{n}    { n, pages: [ { index, label, text } ] }
//    sources/{sourceId}/vectors/{n}  { n, items: [ { p, s, e, v } ] }
//  The page and vector groups keep each Firestore document small.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: createSourceRecord
//  Inputs: parentKind ("template" | "document"), parentId, data (name, kind,
//    pageCount, charCount, indexStatus, ...)
//  Outputs: Promise<string> — the new source's id
///////////////////////////////////////////////////////////////////////////
async function createSourceRecord(parentKind, parentId, data) {
  const ref = await addDoc(
    collection(db, parentCollectionName(parentKind), parentId, "sources"),
    { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
  );
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: updateSourceRecord
//  Inputs: parentKind, parentId, sourceId, data (the fields to change)
//  Outputs: Promise — resolves when saved
//  Summary: Used for renaming, indexStatus changes, and so on.
///////////////////////////////////////////////////////////////////////////
async function updateSourceRecord(parentKind, parentId, sourceId, data) {
  await updateDoc(
    doc(db, parentCollectionName(parentKind), parentId, "sources", sourceId),
    { ...data, updatedAt: serverTimestamp() }
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: getSourceRecord
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise<object | null> — { id, ...fields }, or null
///////////////////////////////////////////////////////////////////////////
async function getSourceRecord(parentKind, parentId, sourceId) {
  const snap = await getDoc(
    doc(db, parentCollectionName(parentKind), parentId, "sources", sourceId)
  );
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

///////////////////////////////////////////////////////////////////////////
//  Function: listSources
//  Inputs: parentKind, parentId
//  Outputs: Promise<object[]> — the parent's sources, oldest first
///////////////////////////////////////////////////////////////////////////
async function listSources(parentKind, parentId) {
  const q = query(
    collection(db, parentCollectionName(parentKind), parentId, "sources"),
    orderBy("createdAt", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteSourceRecord
//  Inputs: parentKind, parentId, sourceId
//  Outputs: Promise — resolves when the source, its pages, and its vectors
//    are deleted
///////////////////////////////////////////////////////////////////////////
async function deleteSourceRecord(parentKind, parentId, sourceId) {
  const sourceRef = doc(db, parentCollectionName(parentKind), parentId, "sources", sourceId);
  await deleteWholeCollection(collection(sourceRef, "pages"));
  await deleteWholeCollection(collection(sourceRef, "vectors"));
  await deleteDoc(sourceRef);
}

///////////////////////////////////////////////////////////////////////////
//  Function: saveSourceGroup
//  Inputs: parentKind, parentId, sourceId, subcollection ("pages" |
//    "vectors"), n (the group number, from 0), payload (for pages, { pages };
//    for vectors, { items })
//  Outputs: Promise — resolves when saved
//  Summary: Writes one group document. Group ids are the number as a
//    string, and the number is also stored as a field, so readers sort by
//    the field ("10" would otherwise sort before "2").
///////////////////////////////////////////////////////////////////////////
async function saveSourceGroup(parentKind, parentId, sourceId, subcollection, n, payload) {
  if (subcollection !== "pages" && subcollection !== "vectors") {
    throw new Error(`Unknown source subcollection "${subcollection}"`);
  }
  await setDoc(
    doc(db, parentCollectionName(parentKind), parentId, "sources", sourceId, subcollection, String(n)),
    { ...payload, n }
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: listSourceGroups
//  Inputs: parentKind, parentId, sourceId, subcollection ("pages" | "vectors")
//  Outputs: Promise<object[]> — the group documents ({ n, ... }) in order
///////////////////////////////////////////////////////////////////////////
async function listSourceGroups(parentKind, parentId, sourceId, subcollection) {
  if (subcollection !== "pages" && subcollection !== "vectors") {
    throw new Error(`Unknown source subcollection "${subcollection}"`);
  }
  const snap = await getDocs(
    collection(db, parentCollectionName(parentKind), parentId, "sources", sourceId, subcollection)
  );
  return snap.docs.map(d => d.data()).sort((a, b) => a.n - b.n);
}

///////////////////////////////////////////////////////////////////////////
// Snapshot helpers
//  A snapshot is a saved copy of a document's mainHtml and tabs, written
//  before a risky change so it can be undone. kind is "before-revision" or
//  "before-format".
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: createSnapshotRecord
//  Inputs: docId, data ({ kind, mainHtml, tabs })
//  Outputs: Promise<string> — the new snapshot's id
///////////////////////////////////////////////////////////////////////////
async function createSnapshotRecord(docId, data) {
  const ref = await addDoc(
    collection(db, DOCUMENTS_COLLECTION, docId, "snapshots"),
    { ...data, createdAt: serverTimestamp() }
  );
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: getLatestSnapshot
//  Inputs: docId, kind ("before-revision" | "before-format")
//  Outputs: Promise<object | null> — the newest snapshot of that kind,
//    { id, ...fields }, or null if there is none
//  Summary: Reads the 20 newest snapshots and picks the kind in code, which
//    avoids needing another Firestore index.
///////////////////////////////////////////////////////////////////////////
async function getLatestSnapshot(docId, kind) {
  const q = query(
    collection(db, DOCUMENTS_COLLECTION, docId, "snapshots"),
    orderBy("createdAt", "desc"),
    limit(20)
  );
  const snap = await getDocs(q);
  const match = snap.docs.find(d => d.data().kind === kind);
  return match ? { id: match.id, ...match.data() } : null;
}

///////////////////////////////////////////////////////////////////////////
//  Function: deleteSnapshotRecord
//  Inputs: docId, snapshotId
//  Outputs: Promise — resolves when deleted
///////////////////////////////////////////////////////////////////////////
async function deleteSnapshotRecord(docId, snapshotId) {
  await deleteDoc(doc(db, DOCUMENTS_COLLECTION, docId, "snapshots", snapshotId));
}

///////////////////////////////////////////////////////////////////////////
// Analysis helpers
//  One argument-analysis run, with its findings, per document.
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: createAnalysisRecord
//  Inputs: docId, data (the run's fields, including its findings)
//  Outputs: Promise<string> — the new analysis's id
///////////////////////////////////////////////////////////////////////////
async function createAnalysisRecord(docId, data) {
  const ref = await addDoc(
    collection(db, DOCUMENTS_COLLECTION, docId, "analyses"),
    { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }
  );
  return ref.id;
}

///////////////////////////////////////////////////////////////////////////
//  Function: updateAnalysisRecord
//  Inputs: docId, analysisId, data (the fields to change, for example the
//    findings array after one is resolved or dismissed)
//  Outputs: Promise — resolves when saved
///////////////////////////////////////////////////////////////////////////
async function updateAnalysisRecord(docId, analysisId, data) {
  await updateDoc(
    doc(db, DOCUMENTS_COLLECTION, docId, "analyses", analysisId),
    { ...data, updatedAt: serverTimestamp() }
  );
}

///////////////////////////////////////////////////////////////////////////
//  Function: listAnalyses
//  Inputs: docId, maxRuns (default 20)
//  Outputs: Promise<object[]> — the document's analysis runs, newest first
///////////////////////////////////////////////////////////////////////////
async function listAnalyses(docId, maxRuns = 20) {
  const q = query(
    collection(db, DOCUMENTS_COLLECTION, docId, "analyses"),
    orderBy("createdAt", "desc"),
    limit(maxRuns)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export {
  auth,
  signUpEmail,
  signInEmail,
  signInGoogle,
  signOutUser,
  onAuthChange,
  getIdToken,
  TEMPLATES_COLLECTION,
  DOCUMENTS_COLLECTION,
  serverNow,
  commitBatch,
  createTemplateRecord,
  saveTemplateRecord,
  renameTemplateRecord,
  deleteTemplateRecord,
  getTemplateRecord,
  listUserTemplates,
  createDocumentRecord,
  saveDocumentRecord,
  saveDocumentWithRevision,
  renameDocumentRecord,
  deleteDocumentRecord,
  getDocumentRecord,
  listUserDocuments,
  createSourceRecord,
  updateSourceRecord,
  getSourceRecord,
  listSources,
  deleteSourceRecord,
  saveSourceGroup,
  listSourceGroups,
  createSnapshotRecord,
  getLatestSnapshot,
  deleteSnapshotRecord,
  createAnalysisRecord,
  updateAnalysisRecord,
  listAnalyses
};