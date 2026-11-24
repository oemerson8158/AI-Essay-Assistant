///////////////////////////////////////////////////////////////////////////
// helpContent.js
//  The wording of every "?" tutorial, as data. help.js registers each entry
//  when it loads. A button opens an entry by carrying its key in a
//  data-help attribute, for example <button data-help="home">?</button>.
//
//  To add a tutorial: add an entry below, then give a button the matching
//  data-help key. To change a tutorial's wording: edit it here.
//
//  Phase 1 has one sample entry so the popup can be tested. Phase 12 (step
//  12.1) writes the real content for Home, the template wizard, Outline,
//  Format, Material, Citations, and the left sidebar.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

const HELP_CONTENT = {
  wizard: {
    title: "Making a template",
    steps: [
      "This is a sample tutorial. Real step-by-step help is written in Phase 12.",
      "Answer the questions about your writing, or leave them blank. Then choose a theme, or build a custom one from a sample essay.",
      "On the review screen you can rename sections, change what each part asks you to write, duplicate, remove, or move sections, then save."
    ]
  },
  home: {
    title: "Home",
    steps: [
      "This is a sample tutorial. Real step-by-step help for each part of the app is written in Phase 12.",
      "Use the numbered buttons below to jump to a step, or Next and Back to move one at a time.",
      "Click “View all steps” to see every step at once. Press Escape, click outside this box, or click Done to close it."
    ]
  }
};

export { HELP_CONTENT };