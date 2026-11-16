///////////////////////////////////////////////////////////////////////////
// defaultTemplates.js
//  The 10 built-in essay themes, as data. Generated from the
//  "Default Essay Templates" PDF: every section name, field label, and
//  prompt (the bracketed text, without the brackets) is the PDF's wording.
//
//  Shape of a theme (see Architecture section 5):
//    { themeId, name, category, sections: [ {
//        id, name, purpose,
//        fields: [ { id, label, prompt, optional } ]
//    } ] }
//
//  - The "(Section N)" markers in the PDF are not stored. They are generated
//    from each section's position wherever sections are shown, so
//    duplicating, removing, or reordering a section always renumbers.
//  - Ids are fixed and readable ("lit-s2", "lit-s2-f3"), so personalization
//    (Phase 4) can be checked against them. They contain no dots, because a
//    dot in a map key is awkward in Firestore field paths. A section
//    duplicated later gets a new random id.
//  - "purpose" is one sentence per section, shown in the left sidebar while
//    writing. The PDF has none, so these were written for this app; edit
//    them here.
//  - Only the DBQ's two "(Optional)" outside-evidence fields carry
//    optional: true.
//
//  The exported data is frozen, so code that tries to change it in place
//  throws an error instead of silently changing every future template. Use
//  buildTemplateFromTheme() or getDefaultTheme() for a copy you can edit.
//
//  Oliver Emerson - 2026
///////////////////////////////////////////////////////////////////////////

// The "Template type" a template can have. Only narrative and lab change
// behavior: argument analysis is not offered for them.
const CATEGORIES = Object.freeze([
  { id: "argumentative", label: "Argumentative" },
  { id: "analytical", label: "Analytical" },
  { id: "informational", label: "Informational" },
  { id: "narrative", label: "Narrative" },
  { id: "lab", label: "Lab report" }
]);

const CATEGORIES_WITHOUT_ARGUMENT_ANALYSIS = ["narrative", "lab"];

// The theme whose Screen B adds a file input for the document packet.
const DBQ_THEME_ID = "dbq";

///////////////////////////////////////////////////////////////////////////
//  Function: defineTheme
//  Inputs: { themeId, abbr, name, category, sections } where each section is
//    { name, purpose, fields: [ [label, prompt, optional?], ... ] }
//  Outputs: A theme object with ids filled in: "<abbr>-s<n>" for sections
//    and "<abbr>-s<n>-f<m>" for fields
//  Summary: Lets the data below be written as compact lists.
///////////////////////////////////////////////////////////////////////////
function defineTheme({ themeId, abbr, name, category, sections }) {
  return {
    themeId,
    name,
    category,
    sections: sections.map((section, i) => {
      const sectionId = `${abbr}-s${i + 1}`;
      return {
        id: sectionId,
        name: section.name,
        purpose: section.purpose,
        fields: section.fields.map(([label, prompt, optional], j) => ({
          id: `${sectionId}-f${j + 1}`,
          label,
          prompt,
          optional: optional === true
        }))
      };
    })
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: deepFreeze
//  Inputs: value (an object or array)
//  Outputs: The same value, frozen all the way down
///////////////////////////////////////////////////////////////////////////
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

///////////////////////////////////////////////////////////////////////////
// The themes
///////////////////////////////////////////////////////////////////////////

const DEFAULT_THEMES = deepFreeze([

  // ---- 1. Literary Analysis Essay ----------------------------------------
  defineTheme({
    themeId: "literary-analysis",
    abbr: "lit",
    name: "Literary Analysis Essay",
    category: "analytical",
    sections: [
      {
        name: "Introduction",
        purpose: "Hook your reader, introduce the text, and state the interpretive claim your essay will prove.",
        fields: [
          ["Hook", "A thought-provoking observation, quotation, question, or statement related to the text's themes, characters, or central ideas"],
          ["Background information", "Introduce the author, title, and any essential context needed to understand the work"],
          ["Brief overview", "Provide a concise summary of the relevant plot, situation, or literary context without excessive retelling"],
          ["Thesis statement", "Present an interpretive claim explaining what the text reveals and how the author develops that meaning through literary elements such as characterization, symbolism, imagery, setting, structure, or tone"]
        ]
      },
      {
        name: "Body Paragraph 1, First Literary Element or Idea",
        purpose: "Make your first analytical point about the text and back it up with evidence and explanation.",
        fields: [
          ["Topic sentence", "Introduce the first analytical point that supports the thesis"],
          ["Context", "Explain the situation or moment in the text where the evidence appears"],
          ["Textual evidence", "Include a relevant quotation or specific example from the text"],
          ["Analysis", "Explain how the evidence supports the claim and contributes to the author's overall meaning or purpose"],
          ["Transition", "Connect this idea to the next aspect of the analysis"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Literary Element or Idea",
        purpose: "Develop a second analytical point, supported by a different piece of evidence from the text.",
        fields: [
          ["Topic sentence", "Introduce the second analytical point"],
          ["Context", "Provide background for the selected evidence"],
          ["Textual evidence", "Present a quotation, passage, or specific example from the text"],
          ["Analysis", "Discuss how the author's literary choices strengthen the theme, character development, conflict, or message"],
          ["Transition", "Lead into the next analytical point"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Literary Element or Idea",
        purpose: "Add a third analytical point with its own evidence, and show how it supports your thesis.",
        fields: [
          ["Topic sentence", "Introduce the third analytical point"],
          ["Context", "Explain the circumstances surrounding the evidence"],
          ["Textual evidence", "Use a quotation or specific example from the work"],
          ["Analysis", "Examine the significance of the evidence and how it supports the thesis"],
          ["Transition", "Prepare the reader for the broader interpretation of the text"]
        ]
      },
      {
        name: "Body Paragraph 4, Deeper Interpretation or Complexity",
        purpose: "Dig into a more complex side of the text, such as irony, conflict, or competing readings, and explain why it matters.",
        fields: [
          ["Extended insight", "Address a more complex aspect of the text, such as conflicting themes, character development, irony, symbolism, or multiple interpretations"],
          ["Supporting evidence", "Provide additional textual support"],
          ["Analysis", "Explore how this complexity enhances the meaning of the work"],
          ["Evaluation", "Explain why this aspect is important to understanding the author's purpose"],
          ["Bridge to conclusion", "Connect the discussion back to the central argument"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Bring your analysis together and explain what it reveals about the text and its meaning.",
        fields: [
          ["Restate thesis", "Rephrase your interpretation while maintaining the same central claim"],
          ["Synthesize analysis", "Bring together the major literary elements and ideas discussed throughout the essay"],
          ["Explain significance", "Discuss what the analysis reveals about the text, its themes, its characters, the author's message, or the human experience"],
          ["Closing statement", "End with a memorable insight, reflection, or observation about the work's lasting meaning or impact"]
        ]
      }
    ]
  }),

  // ---- 2. Argumentative / Persuasive Essay -------------------------------
  defineTheme({
    themeId: "argumentative",
    abbr: "arg",
    name: "Argumentative/Persuasive Essay",
    category: "argumentative",
    sections: [
      {
        name: "Introduction",
        purpose: "Introduce the issue, give the background readers need, and state your position and main reasons.",
        fields: [
          ["Hook", "A compelling fact, statistic, anecdote, quotation, or statement that introduces the issue and captures the reader's attention"],
          ["Background information", "Provide context about the issue, including its significance, history, and relevance to the audience"],
          ["Overview of the debate", "Briefly explain the differing viewpoints or positions surrounding the issue"],
          ["Thesis statement", "Clearly state your position and identify the primary reasons that support your argument"]
        ]
      },
      {
        name: "Body Paragraph 1, First Supporting Argument",
        purpose: "Present your strongest reason with evidence, and explain why it supports your position.",
        fields: [
          ["Topic sentence", "Present the strongest reason supporting your position"],
          ["Evidence", "Include facts, statistics, expert opinions, studies, or examples that support the claim"],
          ["Analysis", "Explain how the evidence validates your argument"],
          ["Significance", "Discuss why this point is important to the overall issue"],
          ["Transition", "Connect this argument to the next supporting point"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Supporting Argument",
        purpose: "Present a second reason with credible evidence, and explain how it strengthens your argument.",
        fields: [
          ["Topic sentence", "Present a second reason supporting your position"],
          ["Evidence", "Provide credible facts, examples, or research"],
          ["Analysis", "Demonstrate how the evidence strengthens the argument"],
          ["Significance", "Explain the broader implications of this point"],
          ["Transition", "Lead into the next supporting argument"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Supporting Argument",
        purpose: "Present a third reason with evidence, and show how it reinforces your stance.",
        fields: [
          ["Topic sentence", "Present a third reason supporting your position"],
          ["Evidence", "Include relevant data, examples, studies, or expert testimony"],
          ["Analysis", "Explain the relationship between the evidence and the thesis"],
          ["Significance", "Show why this point further reinforces your stance"],
          ["Transition", "Prepare the reader for consideration of opposing viewpoints"]
        ]
      },
      {
        name: "Body Paragraph 4, Counterargument and Refutation",
        purpose: "Fairly state the strongest opposing view, then respond to it and reconnect to your claim.",
        fields: [
          ["Opposing viewpoint", "Present the strongest argument against your position fairly and accurately"],
          ["Supporting evidence for opposition", "Explain the reasoning or evidence used by those who disagree"],
          ["Refutation", "Respond to the counterargument by identifying weaknesses, limitations, or overlooked factors"],
          ["Supporting evidence", "Use facts, examples, or research to reinforce your response"],
          ["Bridge to conclusion", "Reconnect the discussion to your overall claim"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your position, pull your reasons together, and leave readers with a lasting final thought.",
        fields: [
          ["Restate thesis", "Rephrase your position using new wording while maintaining the same argument"],
          ["Synthesize key arguments", "Bring together the strongest supporting points and explain how they collectively support your claim"],
          ["Broader significance", "Discuss the importance of the issue and the implications of adopting your position"],
          ["Closing statement", "Conclude with a memorable insight, recommendation, call to action, or prediction about the future"]
        ]
      }
    ]
  }),

  // ---- 3. Personal Narrative / Memoir ------------------------------------
  defineTheme({
    themeId: "personal-narrative",
    abbr: "nar",
    name: "Personal Narrative/Memoir",
    category: "narrative",
    sections: [
      {
        name: "Introduction",
        purpose: "Draw the reader into the experience, set the scene, and introduce the challenge or question at its center.",
        fields: [
          ["Opening scene", "Begin with a vivid moment, meaningful detail, brief dialogue, or reflection that draws the reader into the experience"],
          ["Context", "Provide the background information readers need to understand when, where, and why the experience took place"],
          ["Central conflict or challenge", "Introduce the situation, obstacle, question, or tension that drives the narrative"],
          ["Narrative focus statement", "Briefly indicate the lesson, realization, or personal growth that will emerge from the experience"]
        ]
      },
      {
        name: "Body Paragraph 1, Beginning of the Experience",
        purpose: "Tell the first important moment of the story, and reflect on why it mattered.",
        fields: [
          ["Topic sentence", "Introduce the first significant event or moment in the story"],
          ["Narrative details", "Describe actions, setting, dialogue, sensory details, or thoughts that occurred during this stage"],
          ["Reflection", "Explain why this moment mattered and how it affected your perspective or emotions"],
          ["Transition", "Lead naturally into the next stage of the experience"]
        ]
      },
      {
        name: "Body Paragraph 2, Development of the Experience",
        purpose: "Move the story forward with the next event or turning point, and show what you began to understand.",
        fields: [
          ["Topic sentence", "Introduce the next important event, challenge, or turning point"],
          ["Narrative details", "Develop the story with specific actions, interactions, observations, or reactions"],
          ["Reflection", "Explore what you learned, noticed, or began to understand during this stage"],
          ["Transition", "Connect this event to the next development in the narrative"]
        ]
      },
      {
        name: "Body Paragraph 3, Climax or Turning Point",
        purpose: "Describe the most important moment in vivid detail, and explain how it changed you.",
        fields: [
          ["Topic sentence", "Present the most important moment, realization, decision, or challenge in the narrative"],
          ["Narrative details", "Describe the event with concrete details and emotional depth"],
          ["Reflection", "Explain how this moment changed your thinking, behavior, beliefs, or understanding"],
          ["Transition", "Move the reader toward the outcome and final reflection"]
        ]
      },
      {
        name: "Body Paragraph 4, Resolution and Aftermath",
        purpose: "Show what happened afterward and how the experience kept shaping you.",
        fields: [
          ["Outcome", "Describe what happened after the turning point"],
          ["Personal response", "Explain your thoughts, feelings, or actions following the experience"],
          ["Lasting impact", "Discuss how the event continued to influence you afterward"],
          ["Bridge to conclusion", "Connect the experience to its larger meaning"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Return to the experience from a new perspective, and share what it taught you.",
        fields: [
          ["Revisit the experience", "Briefly return to the central event or moment from a new perspective"],
          ["Synthesize insights", "Connect the major events and reflections into a cohesive understanding"],
          ["Final reflection", "Explain the broader lesson, personal growth, or significance of the experience"],
          ["Closing statement", "End with a memorable insight, image, or thought that leaves a lasting impression on the reader"]
        ]
      }
    ]
  }),

  // ---- 4. Compare and Contrast Essay -------------------------------------
  defineTheme({
    themeId: "compare-contrast",
    abbr: "cmp",
    name: "Compare and Contrast Essay",
    category: "analytical",
    sections: [
      {
        name: "Introduction",
        purpose: "Introduce both subjects, explain why they are worth comparing, and state your main conclusion about them.",
        fields: [
          ["Attention getter", "An interesting fact, observation, scenario, or statement that introduces both subjects and establishes the basis for comparison"],
          ["Background information", "Briefly explain the two subjects and why comparing them is meaningful"],
          ["Basis for comparison", "Identify the specific categories, characteristics, or criteria that will be examined"],
          ["Thesis statement", "Present the main conclusion about the similarities, differences, or overall relationship between the two subjects"]
        ]
      },
      {
        name: "Body Paragraph 1, First Point of Comparison",
        purpose: "Compare the two subjects on your first category, and explain what the similarity or difference shows.",
        fields: [
          ["Topic sentence", "Introduce the first category or characteristic being compared"],
          ["Subject A evidence", "Provide details, examples, or facts related to the first subject"],
          ["Subject B evidence", "Provide corresponding details, examples, or facts related to the second subject"],
          ["Analysis", "Explain the significance of the similarity or difference and how it supports the thesis"],
          ["Transition", "Lead into the next point of comparison"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Point of Comparison",
        purpose: "Compare the subjects on a second category, and explain what the comparison reveals.",
        fields: [
          ["Topic sentence", "Introduce the second category or characteristic"],
          ["Subject A evidence", "Relevant information about the first subject"],
          ["Subject B evidence", "Relevant information about the second subject"],
          ["Analysis", "Discuss what the comparison reveals and why it matters"],
          ["Transition", "Connect this discussion to the next comparison point"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Point of Comparison",
        purpose: "Compare the subjects on a third category, and show how it strengthens your overall conclusion.",
        fields: [
          ["Topic sentence", "Introduce the third category or characteristic"],
          ["Subject A evidence", "Supporting details about the first subject"],
          ["Subject B evidence", "Supporting details about the second subject"],
          ["Analysis", "Explain how the comparison strengthens the overall argument or conclusion"],
          ["Transition", "Guide the reader toward the final evaluation"]
        ]
      },
      {
        name: "Body Paragraph 4, Overall Evaluation",
        purpose: "Address the most important similarity or difference between the subjects, and explain its significance.",
        fields: [
          ["Major similarity or difference", "Address the most important distinction or connection between the subjects"],
          ["Supporting evidence", "Examples, observations, or facts that reinforce this evaluation"],
          ["Analysis", "Explain the broader significance of this comparison"],
          ["Bridge to conclusion", "Connect the evaluation to the essay's final takeaway"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your conclusion, bring the comparisons together, and explain what readers should take away.",
        fields: [
          ["Restate thesis", "Rephrase your overall conclusion about the relationship between the two subjects"],
          ["Synthesize comparisons", "Bring together the major similarities and differences discussed throughout the essay"],
          ["Explain significance", "Discuss what readers should learn or understand from the comparison"],
          ["Closing statement", "End with a final insight, implication, recommendation, or thought-provoking observation"]
        ]
      }
    ]
  }),

  // ---- 5. Rhetorical Analysis Essay --------------------------------------
  defineTheme({
    themeId: "rhetorical-analysis",
    abbr: "rhe",
    name: "Rhetorical Analysis Essay",
    category: "analytical",
    sections: [
      {
        name: "Introduction",
        purpose: "Introduce the text and its rhetorical situation, and state how the author uses strategies to reach the audience.",
        fields: [
          ["Hook", "An engaging statement, observation, quotation, or description that introduces the speaker, text, or rhetorical situation"],
          ["Context", "Briefly explain the author, audience, purpose, occasion, and circumstances surrounding the text"],
          ["Main claim or message", "Summarize the author's central argument, purpose, or position"],
          ["Thesis statement", "State how the author uses rhetorical strategies to achieve their purpose and influence the intended audience"]
        ]
      },
      {
        name: "Body Paragraph 1, First Rhetorical Strategy",
        purpose: "Analyze the first rhetorical strategy with evidence, and explain how it affects the audience.",
        fields: [
          ["Topic sentence", "Identify the first rhetorical appeal, device, or strategy used by the author"],
          ["Textual evidence", "A quotation, example, or passage demonstrating the strategy"],
          ["Analysis", "Explain how the strategy functions within the text"],
          ["Effect on audience", "Discuss how the strategy shapes audience understanding, emotions, beliefs, or reactions"],
          ["Transition", "Connect this strategy to the next rhetorical choice"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Rhetorical Strategy",
        purpose: "Analyze a second strategy with evidence, and show how it advances the author's purpose.",
        fields: [
          ["Topic sentence", "Introduce the second rhetorical strategy"],
          ["Textual evidence", "Relevant quotation, example, or passage"],
          ["Analysis", "Explain how the author develops this strategy and why it is effective"],
          ["Effect on audience", "Analyze the impact on the intended audience and how it advances the author's purpose"],
          ["Transition", "Lead into the next rhetorical strategy"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Rhetorical Strategy",
        purpose: "Analyze a third strategy with evidence, and show how it contributes to the overall argument.",
        fields: [
          ["Topic sentence", "Introduce the third rhetorical strategy"],
          ["Textual evidence", "A passage, example, or rhetorical choice from the text"],
          ["Analysis", "Discuss how this technique contributes to the overall argument or purpose"],
          ["Effect on audience", "Explain how the audience is influenced by this rhetorical choice"],
          ["Transition", "Guide the reader toward an evaluation of the author's overall effectiveness"]
        ]
      },
      {
        name: "Body Paragraph 4, Overall Effectiveness",
        purpose: "Judge how well the strategies work together to achieve the author's purpose.",
        fields: [
          ["Evaluation", "Assess how the rhetorical strategies work together to support the author's purpose"],
          ["Supporting evidence", "Examples from across the text that demonstrate the combined effect of the strategies"],
          ["Analysis", "Explain why the author's rhetorical choices are successful, partially successful, or ineffective"],
          ["Bridge to conclusion", "Connect the evaluation to the broader significance of the text"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your evaluation, pull the strategies together, and explain why the text's rhetoric matters.",
        fields: [
          ["Restate thesis", "Rephrase your evaluation of the author's rhetorical choices and effectiveness"],
          ["Synthesize analysis", "Bring together the major strategies discussed and explain how they contribute to the author's purpose"],
          ["Discuss significance", "Explain what the analysis reveals about the text, audience, message, or rhetorical situation"],
          ["Closing statement", "End with a final insight about the power, impact, or relevance of the author's communication"]
        ]
      }
    ]
  }),

  // ---- 6. Research Paper -------------------------------------------------
  defineTheme({
    themeId: "research-paper",
    abbr: "res",
    name: "Research Paper",
    category: "argumentative",
    sections: [
      {
        name: "Introduction",
        purpose: "Introduce the topic, show why it deserves investigation, and state your research question and thesis.",
        fields: [
          ["Hook", "An interesting fact, observation, quotation, statistic, or scenario that introduces the research topic and captures the reader's attention"],
          ["Background information", "Provide relevant context, explain the issue, and establish why the topic is important or worthy of investigation"],
          ["Research problem or question", "Identify the specific issue, gap in knowledge, or question the paper seeks to address"],
          ["Thesis statement", "Present the central argument, finding, or position that the research will support through evidence and analysis"]
        ]
      },
      {
        name: "Body Paragraph 1, First Major Finding or Argument",
        purpose: "Present your first major finding with research evidence, and explain how it supports your thesis.",
        fields: [
          ["Topic sentence", "Introduce the first major claim, finding, or area of investigation"],
          ["Research evidence", "Present data, studies, scholarly sources, statistics, or expert opinions relevant to this point"],
          ["Analysis", "Interpret the evidence and explain how it supports the thesis"],
          ["Significance", "Discuss why this information is important to understanding the topic"],
          ["Transition", "Connect this section to the next major point"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Major Finding or Argument",
        purpose: "Present a second major finding with credible sources, and interpret what it shows.",
        fields: [
          ["Topic sentence", "Introduce the second major claim, finding, or area of investigation"],
          ["Research evidence", "Provide supporting information from credible sources"],
          ["Analysis", "Explain the connection between the evidence and the thesis"],
          ["Significance", "Discuss what this evidence reveals about the issue"],
          ["Transition", "Lead into the next section of the research"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Major Finding or Argument",
        purpose: "Present a third major finding with evidence, and show how it strengthens your argument.",
        fields: [
          ["Topic sentence", "Introduce the third major claim, finding, or area of investigation"],
          ["Research evidence", "Include supporting studies, examples, data, or expert perspectives"],
          ["Analysis", "Evaluate and interpret the evidence"],
          ["Significance", "Explain how this information strengthens the overall argument"],
          ["Transition", "Prepare the reader for alternative perspectives, limitations, or broader discussion"]
        ]
      },
      {
        name: "Body Paragraph 4, Counterargument, Limitations, or Alternative Perspective",
        purpose: "Address a counterargument, limitation, or alternative view, and explain how your thesis holds up.",
        fields: [
          ["Alternative viewpoint", "Present a competing interpretation, criticism, or limitation related to the topic"],
          ["Evidence", "Provide research supporting this perspective"],
          ["Evaluation", "Analyze the strengths and weaknesses of the alternative viewpoint"],
          ["Response", "Explain why the thesis remains valid, or clarify how the alternative perspective contributes to a fuller understanding"],
          ["Transition", "Connect the discussion to the paper's overall conclusions"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your thesis, pull your key findings together, and discuss what the research implies.",
        fields: [
          ["Restate thesis", "Reinforce the central argument or finding using fresh wording"],
          ["Synthesize key findings", "Bring together the major pieces of evidence and explain how they support the thesis"],
          ["Broader implications", "Discuss what the research suggests about the topic, society, policy, future study, or real-world applications"],
          ["Closing statement", "End with a final insight, recommendation, prediction, or thought-provoking observation"]
        ]
      }
    ]
  }),

  // ---- 7. Lab Report -----------------------------------------------------
  defineTheme({
    themeId: "lab-report",
    abbr: "lab",
    name: "Lab Report",
    category: "lab",
    sections: [
      {
        name: "Title and Header",
        purpose: "Name the experiment, identify who did it, and say in a sentence what it investigates.",
        fields: [
          ["Experiment title", "A clear, descriptive title that identifies the investigation or experiment"],
          ["Researcher information", "Name, date, class, lab group, or other required identifying details"],
          ["Purpose statement", "A brief explanation of what the experiment seeks to investigate or measure"]
        ]
      },
      {
        name: "Introduction and Hypothesis",
        purpose: "Give the scientific background, state your research question and variables, and make a testable prediction.",
        fields: [
          ["Background information", "Relevant scientific concepts, principles, or prior knowledge necessary to understand the experiment"],
          ["Research question", "The specific question the experiment is designed to answer"],
          ["Variables", "Identify the independent variable, dependent variable, and any controlled variables"],
          ["Hypothesis", "A testable prediction explaining what is expected to happen and why"]
        ]
      },
      {
        name: "Materials and Procedure",
        purpose: "List what you used and describe the method clearly enough for someone else to repeat it.",
        fields: [
          ["Materials", "List all equipment, tools, substances, and resources used during the experiment"],
          ["Experimental setup", "Describe how the investigation was organized and prepared"],
          ["Procedure", "Provide a clear, step-by-step summary of the methods followed"],
          ["Safety considerations", "Note any precautions or safety measures taken during the investigation"]
        ]
      },
      {
        name: "Results and Observations",
        purpose: "Present what you measured and observed, and point out the patterns in the data.",
        fields: [
          ["Data collection", "Present measurements, observations, calculations, or recorded findings"],
          ["Tables or figures", "Reference charts, graphs, diagrams, or data tables when applicable"],
          ["Trends and patterns", "Identify notable relationships, changes, or outcomes observed in the data"],
          ["Transition", "Lead into the interpretation and analysis of the results"]
        ]
      },
      {
        name: "Analysis and Evaluation",
        purpose: "Interpret what the data show, discuss sources of error, and judge how reliable your method was.",
        fields: [
          ["Data interpretation", "Explain what the results indicate in relation to the research question"],
          ["Evidence", "Reference specific data, observations, or calculations that support the analysis"],
          ["Sources of error", "Discuss limitations, uncertainties, or factors that may have influenced the results"],
          ["Evaluation", "Assess the reliability, accuracy, and effectiveness of the experimental procedure"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Say whether your hypothesis was supported, summarize the key findings, and suggest next steps.",
        fields: [
          ["Restate the purpose", "Return to the original objective or research question"],
          ["Evaluate the hypothesis", "State whether the results supported or contradicted the prediction"],
          ["Summarize findings", "Highlight the most important results and observations"],
          ["Future improvements or applications", "Suggest ways the experiment could be improved, expanded, or applied to future investigations"],
          ["Closing statement", "End with a final observation about the significance of the findings"]
        ]
      }
    ]
  }),

  // ---- 8. Current Event Report -------------------------------------------
  defineTheme({
    themeId: "current-event",
    abbr: "cur",
    name: "Current Event Report",
    category: "informational",
    sections: [
      {
        name: "Introduction",
        purpose: "Introduce the event, give the context needed to understand it, and state what your report focuses on.",
        fields: [
          ["Hook", "A recent statistic, surprising fact, notable quotation, or brief description that introduces the current event and captures the reader's attention"],
          ["Event overview", "Identify the event, where and when it occurred, and the individuals, organizations, or groups involved"],
          ["Background information", "Provide the context necessary to understand the event, including causes, history, or relevant circumstances"],
          ["Main focus statement", "State the purpose of the report and the significance of the event being examined"]
        ]
      },
      {
        name: "Body Paragraph 1, Description of the Event",
        purpose: "Explain clearly what happened, using facts from credible sources.",
        fields: [
          ["Topic sentence", "Introduce the key details of what happened"],
          ["Event details", "Summarize the major facts, actions, decisions, or developments associated with the event"],
          ["Supporting information", "Include information from news reports, official statements, or credible sources"],
          ["Significance", "Explain why these details are important to understanding the event"],
          ["Transition", "Lead into a discussion of causes, effects, or reactions"]
        ]
      },
      {
        name: "Body Paragraph 2, Causes or Contributing Factors",
        purpose: "Explain the factors that led to the event, supported by evidence.",
        fields: [
          ["Topic sentence", "Introduce the factors that led to the event"],
          ["Supporting evidence", "Provide facts, expert commentary, historical information, or research related to the causes"],
          ["Analysis", "Explain how these factors contributed to the event's occurrence"],
          ["Significance", "Discuss what these causes reveal about the larger issue"],
          ["Transition", "Connect the causes to the event's impact"]
        ]
      },
      {
        name: "Body Paragraph 3, Impact and Reactions",
        purpose: "Describe the consequences of the event and how different groups have responded.",
        fields: [
          ["Topic sentence", "Introduce the consequences of the event"],
          ["Supporting evidence", "Include public responses, government actions, organizational statements, or community reactions"],
          ["Analysis", "Explain how different groups have been affected or influenced"],
          ["Significance", "Discuss the importance of these outcomes and responses"],
          ["Transition", "Lead into broader implications or future developments"]
        ]
      },
      {
        name: "Body Paragraph 4, Broader Implications or Future Outlook",
        purpose: "Look ahead to what the event might mean for the larger issue, and why it could matter in the long run.",
        fields: [
          ["Key implication", "Identify a larger issue, trend, or concern connected to the event"],
          ["Supporting evidence", "Provide expert opinions, forecasts, or additional reporting"],
          ["Analysis", "Explain what the event might mean moving forward"],
          ["Evaluation", "Assess the event's potential long-term importance"],
          ["Bridge to conclusion", "Connect the discussion to the report's final takeaway"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Revisit the event, pull the key points together, and explain why it matters.",
        fields: [
          ["Restate the focus", "Revisit the event and its primary significance"],
          ["Summarize key findings", "Briefly connect the major facts, causes, effects, and implications discussed in the report"],
          ["Reflect on importance", "Explain why the event matters on a local, national, or global level"],
          ["Closing statement", "End with a thoughtful observation, future consideration, or broader takeaway related to the event"]
        ]
      }
    ]
  }),

  // ---- 9. Document Based Question ----------------------------------------
  defineTheme({
    themeId: DBQ_THEME_ID,
    abbr: "dbq",
    name: "Document Based Question",
    category: "argumentative",
    sections: [
      {
        name: "Introduction",
        purpose: "Set the historical scene, introduce the issue, and state a thesis that answers the prompt.",
        fields: [
          ["Hook", "A relevant historical observation, quotation, statistic, or statement that introduces the topic and time period"],
          ["Historical context", "Describe the broader events, developments, or circumstances that provide background for the prompt"],
          ["Brief overview of the issue", "Identify the historical topic, groups, events, or ideas involved"],
          ["Thesis statement", "Present a historically defensible argument that directly answers the prompt and previews the main categories of evidence that will support the claim"]
        ]
      },
      {
        name: "Body Paragraph 1, First Line of Argument",
        purpose: "Make your first line of argument using the documents and, where you can, outside evidence.",
        fields: [
          ["Topic sentence", "Introduce the first major claim supporting the thesis"],
          ["Document evidence", "Incorporate information from one or more provided documents"],
          ["Document analysis", "Explain how the document supports the argument and consider factors such as purpose, audience, point of view, or historical situation"],
          ["Outside evidence", "Provide a relevant historical example or fact not found in the documents"],
          ["Analysis", "Explain how both the document and outside evidence strengthen the argument"],
          ["Transition", "Connect to the next line of reasoning"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Line of Argument",
        purpose: "Make a second line of argument supported by additional documents.",
        fields: [
          ["Topic sentence", "Introduce the second major claim supporting the thesis"],
          ["Document evidence", "Use relevant information from one or more additional documents"],
          ["Document analysis", "Evaluate the document's significance and relationship to the argument"],
          ["Outside evidence", "Include another relevant historical example beyond the provided documents", true],
          ["Analysis", "Explain how the evidence supports the thesis"],
          ["Transition", "Lead into the next argument"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Line of Argument",
        purpose: "Make a third line of argument, analyzing how each document's perspective and context shape its meaning.",
        fields: [
          ["Topic sentence", "Introduce the third major claim supporting the thesis"],
          ["Document evidence", "Use additional documents as support"],
          ["Document analysis", "Discuss how the document's perspective, audience, purpose, or context contributes to its meaning"],
          ["Outside evidence", "Provide additional historical knowledge relevant to this point", true],
          ["Analysis", "Demonstrate how the evidence reinforces the overall argument"],
          ["Transition", "Guide the reader toward a broader evaluation of the topic"]
        ]
      },
      {
        name: "Body Paragraph 4, Complexity or Alternative Perspective",
        purpose: "Address a limitation, exception, or competing perspective to give a fuller picture of the topic.",
        fields: [
          ["Counterargument or qualification", "Present a limitation, exception, alternative interpretation, or competing historical perspective"],
          ["Document evidence", "Reference a document that supports or complicates this perspective"],
          ["Additional evidence", "Include relevant historical knowledge that adds nuance"],
          ["Analysis", "Explain how considering multiple perspectives creates a more complete understanding of the topic"],
          ["Bridge to conclusion", "Connect the discussion back to the thesis"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your thesis, pull your strongest evidence together, and explain the broader historical significance.",
        fields: [
          ["Restate thesis", "Rephrase the argument while maintaining the same overall position"],
          ["Synthesize evidence", "Bring together the most important document and outside evidence used throughout the essay"],
          ["Broader historical significance", "Explain how the topic connects to larger historical developments, themes, patterns, or consequences"],
          ["Closing statement", "End with a final insight about the lasting importance of the historical issue, event, movement, or change"]
        ]
      }
    ]
  }),

  // ---- 10. Long Essay Question -------------------------------------------
  defineTheme({
    themeId: "long-essay",
    abbr: "les",
    name: "Long Essay Question",
    category: "argumentative",
    sections: [
      {
        name: "Introduction",
        purpose: "Set the historical context, introduce the topic, and state a thesis that answers the prompt.",
        fields: [
          ["Hook", "A compelling historical observation, quotation, trend, or statement that introduces the topic addressed in the prompt"],
          ["Historical context", "Explain the broader developments, events, or conditions that occurred before the time period in the prompt and help frame the argument"],
          ["Topic overview", "Briefly identify the historical issue, movement, event, or process being examined"],
          ["Thesis statement", "Present a historically defensible claim that directly answers the prompt and previews the major arguments that will support your position"]
        ]
      },
      {
        name: "Body Paragraph 1, First Supporting Argument",
        purpose: "Make your first supporting argument with specific historical evidence, and explain how it answers the prompt.",
        fields: [
          ["Topic sentence", "Introduce the first major reason your thesis is valid"],
          ["Historical evidence", "Provide a specific event, development, policy, individual, or example that supports the claim"],
          ["Analysis", "Explain how the evidence supports the argument and answers the prompt"],
          ["Historical connection", "Show the relationship between the evidence and larger historical trends or developments"],
          ["Transition", "Lead into the next line of reasoning"]
        ]
      },
      {
        name: "Body Paragraph 2, Second Supporting Argument",
        purpose: "Make a second supporting argument with different historical evidence.",
        fields: [
          ["Topic sentence", "Introduce the second major reason supporting your thesis"],
          ["Historical evidence", "Present another specific and relevant example"],
          ["Analysis", "Explain the significance of the evidence and its connection to the argument"],
          ["Historical connection", "Discuss how this example reflects broader historical patterns, changes, or continuities"],
          ["Transition", "Connect this discussion to the next argument"]
        ]
      },
      {
        name: "Body Paragraph 3, Third Supporting Argument",
        purpose: "Make a third supporting argument, and show how it fits within the period.",
        fields: [
          ["Topic sentence", "Introduce the third major reason supporting your thesis"],
          ["Historical evidence", "Provide an additional event, development, individual, or historical example"],
          ["Analysis", "Explain how the evidence reinforces your claim"],
          ["Historical connection", "Show how the example fits within the historical circumstances of the period"],
          ["Transition", "Guide the reader toward a broader evaluation of the issue"]
        ]
      },
      {
        name: "Body Paragraph 4, Complexity or Qualification",
        purpose: "Address an exception, limitation, or competing interpretation to show a nuanced understanding.",
        fields: [
          ["Alternative perspective", "Address an exception, limitation, counterargument, or competing historical interpretation"],
          ["Supporting evidence", "Provide historical examples that support this qualification"],
          ["Analysis", "Explain how the alternative perspective complicates or refines the argument"],
          ["Evaluation", "Demonstrate a nuanced understanding by weighing multiple factors or viewpoints"],
          ["Bridge to conclusion", "Reconnect the discussion to the overall thesis"]
        ]
      },
      {
        name: "Conclusion",
        purpose: "Restate your thesis, pull your examples together, and explain the larger historical significance.",
        fields: [
          ["Restate thesis", "Rephrase the central argument while maintaining the same position"],
          ["Synthesize evidence", "Bring together the most important examples and explain how they collectively support the claim"],
          ["Broader historical significance", "Discuss what the argument reveals about larger historical patterns, causes, effects, continuity, or change"],
          ["Closing statement", "End with a final insight concerning the long-term importance or impact of the historical development discussed in the essay"]
        ]
      }
    ]
  })
]);

// For dropdowns: [{ themeId, name }] in the PDF's order.
const THEME_OPTIONS = Object.freeze(
  DEFAULT_THEMES.map(({ themeId, name }) => Object.freeze({ themeId, name }))
);

///////////////////////////////////////////////////////////////////////////
// Looking themes up
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
//  Function: getDefaultTheme
//  Inputs: themeId
//  Outputs: An editable deep copy of the theme, or null if there is no such
//    default theme (for example "custom")
///////////////////////////////////////////////////////////////////////////
function getDefaultTheme(themeId) {
  const theme = DEFAULT_THEMES.find(t => t.themeId === themeId);
  return theme ? JSON.parse(JSON.stringify(theme)) : null;
}

///////////////////////////////////////////////////////////////////////////
//  Function: getThemeName
//  Inputs: themeId
//  Outputs: The theme's display name, or "Custom" for "custom" or anything
//    unrecognized
///////////////////////////////////////////////////////////////////////////
function getThemeName(themeId) {
  const theme = DEFAULT_THEMES.find(t => t.themeId === themeId);
  return theme ? theme.name : "Custom";
}

///////////////////////////////////////////////////////////////////////////
//  Function: buildTemplateFromTheme
//  Inputs: themeId
//  Outputs: { title, themeId, category, sections } ready to pass to
//    createTemplateRecord (an editable copy), or null for an unknown theme
//  Summary: The unpersonalized starting point. The wizard (Phase 4) sends
//    these sections to /template/personalize before saving.
///////////////////////////////////////////////////////////////////////////
function buildTemplateFromTheme(themeId) {
  const theme = getDefaultTheme(themeId);
  if (!theme) return null;
  return {
    title: theme.name,
    themeId: theme.themeId,
    category: theme.category,
    sections: theme.sections
  };
}

///////////////////////////////////////////////////////////////////////////
//  Function: categoryAllowsArgumentAnalysis
//  Inputs: category
//  Outputs: false for "narrative" and "lab", true for everything else
///////////////////////////////////////////////////////////////////////////
function categoryAllowsArgumentAnalysis(category) {
  return !CATEGORIES_WITHOUT_ARGUMENT_ANALYSIS.includes(category);
}

export {
  DEFAULT_THEMES,
  THEME_OPTIONS,
  CATEGORIES,
  DBQ_THEME_ID,
  getDefaultTheme,
  getThemeName,
  buildTemplateFromTheme,
  categoryAllowsArgumentAnalysis
};