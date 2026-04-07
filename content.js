const DEFAULT_BACKEND_URL = "http://localhost:5000/generate-product-content";

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "generateDescription") {
    generateDescription()
      .then((message) => sendResponse({ ok: true, message }))
      .catch((error) => {
        console.error("Failed to generate Shopify product content:", error);
        sendResponse({
          ok: false,
          message:
            error.message || "Something went wrong while generating content.",
        });
      });

    return true;
  }

  if (request.action === "inspectEditor") {
    try {
      const diagnostics = inspectEditorState();
      console.group("Shopify AI Product Generator Diagnostics");
      console.log(diagnostics);
      console.groupEnd();
      sendResponse({
        ok: true,
        message: diagnostics.summary,
        diagnostics,
      });
    } catch (error) {
      sendResponse({
        ok: false,
        message: error.message || "Could not inspect the Shopify editor.",
      });
    }

    return false;
  }

  return false;
});

async function generateDescription() {
  const titleInput = findProductTitleInput();

  if (!titleInput || !titleInput.value.trim()) {
    throw new Error("Product title not found on this Shopify page.");
  }

  const editor = findDescriptionEditor();

  if (!editor) {
    throw new Error("Product description editor not found on this page.");
  }

  const payload = await requestGeneratedContent(titleInput.value.trim());
  await insertGeneratedContent(editor, payload);

  return "Description inserted successfully.";
}

function findProductTitleInput() {
  const selectors = [
    'input[name="title"]',
    'input[id*="title"]',
    'input[placeholder*="title" i]',
    'input[aria-label*="title" i]',
    'input[type="text"]',
  ];

  return findFirstVisibleElement(selectors, (element) => {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    const value = element.value.trim();
    const fieldHint = [
      element.name,
      element.id,
      element.placeholder,
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return Boolean(value || fieldHint.includes("title"));
  });
}

function findDescriptionEditor() {
  const sectionBasedEditor = findEditorNearDescriptionLabel();

  if (sectionBasedEditor) {
    return sectionBasedEditor;
  }

  const selectors = [
    ".ProseMirror",
    '[class*="ProseMirror"]',
    '[data-lexical-editor="true"]',
    '[aria-multiline="true"]',
    '[aria-label*="description" i][contenteditable="true"]',
    '[data-placeholder*="description" i][contenteditable="true"]',
    '[contenteditable="true"][translate="yes"]',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea[name*="description" i]',
    "textarea",
  ];

  return findFirstVisibleElement(selectors, (element) => {
    const hint = [
      element.getAttribute("aria-label"),
      element.getAttribute("data-placeholder"),
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.closest("[data-testid]")?.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (element instanceof HTMLTextAreaElement) {
      return hint.includes("description") || element.rows > 3;
    }

    return hint.includes("description") || element.matches('[role="textbox"]');
  });
}

function findEditorNearDescriptionLabel() {
  const descriptionLabel = Array.from(
    document.querySelectorAll("label, h1, h2, h3, h4, h5, h6, span, p, div"),
  ).find((element) => element.textContent?.trim() === "Description");

  if (!descriptionLabel) {
    return null;
  }

  const searchRoots = [
    descriptionLabel.closest("section"),
    descriptionLabel.closest('[class*="Card"]'),
    descriptionLabel.closest('[class*="card"]'),
    descriptionLabel.closest('[class*="Box"]'),
    descriptionLabel.closest("form"),
    descriptionLabel.parentElement,
    descriptionLabel.nextElementSibling,
  ].filter(Boolean);

  for (const root of searchRoots) {
    const editor = findEditorWithinRoot(root);

    if (editor) {
      return editor;
    }
  }

  return null;
}

function getEditorSearchRoot(editor) {
  return (
    editor.closest("form") ||
    editor.closest("section") ||
    editor.parentElement ||
    document
  );
}

function findEditorWithinRoot(root) {
  const directMatch = queryAllDeep(
    [
      ".ProseMirror",
      '[class*="ProseMirror"]',
      '[data-lexical-editor="true"]',
      '[data-slate-editor="true"]',
      '[aria-multiline="true"]',
      '[contenteditable="true"]',
      "textarea",
      '[role="textbox"]',
    ].join(", "),
    root,
  ).find((element) => isVisible(element) && !isDisabled(element));

  if (directMatch) {
    return directMatch;
  }

  return (
    Array.from(root.querySelectorAll("div"))
      .filter((element) => isVisible(element) && !isDisabled(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const className =
          typeof element.className === "string"
            ? element.className.toLowerCase()
            : "";
        const ariaLabel = (
          element.getAttribute("aria-label") || ""
        ).toLowerCase();

        return (
          rect.height >= 120 &&
          rect.width >= 250 &&
          (className.includes("editor") ||
            className.includes("prosemirror") ||
            className.includes("richtext") ||
            className.includes("lexical") ||
            ariaLabel.includes("description") ||
            ariaLabel.includes("editor"))
        );
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (
          rightRect.height * rightRect.width - leftRect.height * leftRect.width
        );
      })[0] || null
  );
}

function findFirstVisibleElement(selectors, predicate = () => true) {
  for (const selector of selectors) {
    const candidates = queryAllDeep(selector);
    const match = candidates.find(
      (element) =>
        isVisible(element) && !isDisabled(element) && predicate(element),
    );

    if (match) {
      return match;
    }
  }

  return null;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function isDisabled(element) {
  if ("disabled" in element && element.disabled) {
    return true;
  }

  return element.getAttribute("aria-disabled") === "true";
}

async function requestGeneratedContent(title) {
  let response;
  const backendUrl = await getBackendUrl();

  try {
    response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });
  } catch (_error) {
    throw new Error(`Could not reach the backend on ${backendUrl}.`);
  }

  let data;

  try {
    data = await response.json();
  } catch (_error) {
    throw new Error("Backend returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data.error || "Backend request failed.");
  }

  if (!data.description || !Array.isArray(data.bullets)) {
    throw new Error("Backend response is missing required content fields.");
  }

  return data;
}

async function getBackendUrl() {
  if (!chrome?.storage?.sync) {
    return DEFAULT_BACKEND_URL;
  }

  return new Promise((resolve) => {
    chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND_URL }, (result) => {
      resolve(result.backendUrl || DEFAULT_BACKEND_URL);
    });
  });
}

async function insertGeneratedContent(editor, data) {
  const markup = buildMarkup(data);
  const plainText = buildPlainText(data);
  const stateField = findDescriptionStateField(editor);

  if (stateField) {
    setFormControlValue(stateField, markup);
    await syncVisibleEditor(editor, markup, plainText);
    return;
  }

  const insertedViaHtmlEditor = await tryInsertViaHtmlEditor(editor, markup);

  if (insertedViaHtmlEditor) {
    return;
  }

  const target = await resolveEditableTarget(editor);

  if (!target) {
    const inserted = await insertIntoContentSurface(editor, markup, plainText);

    if (!inserted) {
      throw new Error(
        "Found the description area, but not an editable field inside it.",
      );
    }

    return;
  }

  writeToTarget(target, markup, plainText);
}

async function resolveEditableTarget(editor) {
  if (editor instanceof HTMLTextAreaElement) {
    return editor;
  }

  if (
    editor.matches?.(
      [
        ".ProseMirror",
        '[class*="ProseMirror"]',
        '[data-lexical-editor="true"]',
        '[aria-multiline="true"]',
        '[contenteditable="true"]',
      ].join(", "),
    )
  ) {
    return editor;
  }

  const immediateTarget = findEditableDescendant(editor);

  if (immediateTarget) {
    return immediateTarget;
  }

  activateEditorSurface(editor);
  await wait(150);

  const activatedTarget =
    findEditableDescendant(editor) || findEditableFromActiveElement(editor);

  if (activatedTarget) {
    return activatedTarget;
  }

  return null;
}

function findEditableDescendant(root) {
  return (
    queryAllDeep(
      [
        ".ProseMirror",
        '[class*="ProseMirror"]',
        '[data-lexical-editor="true"]',
        '[data-slate-editor="true"]',
        '[aria-multiline="true"]',
        '[contenteditable="true"]',
        "textarea",
        '[role="textbox"]',
        '[tabindex="0"]',
      ].join(", "),
      root,
    ).find((element) => isVisible(element) && !isDisabled(element)) || null
  );
}

function findDescriptionStateField(editor) {
  const root = getEditorSearchRoot(editor);
  const candidates = findCandidateStateFields(root);
  return candidates[0] || null;
}

function findCandidateStateFields(root) {
  const selectors = [
    'textarea[name*="body" i]',
    'textarea[name*="description" i]',
    'textarea[name*="html" i]',
    'input[type="hidden"][name*="body" i]',
    'input[type="hidden"][name*="description" i]',
    'input[type="hidden"][name*="html" i]',
    'input[type="hidden"][id*="body" i]',
    'input[type="hidden"][id*="description" i]',
    'textarea[id*="body" i]',
    'textarea[id*="description" i]',
  ];

  return selectors
    .flatMap((selector) => queryAllDeep(selector, root))
    .filter((element, index, array) => array.indexOf(element) === index)
    .filter((element) => {
      const hint = [
        element.getAttribute("name"),
        element.getAttribute("id"),
        element.getAttribute("data-testid"),
        element.getAttribute("aria-label"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        hint.includes("body") ||
        hint.includes("description") ||
        hint.includes("html")
      );
    });
}

function findEditableFromActiveElement(root) {
  const activeElement = getDeepActiveElement();

  if (!activeElement || !root.contains(activeElement)) {
    const nearest = findNearestEditableAncestor(activeElement);
    return nearest && root.contains(nearest) ? nearest : null;
  }

  if (
    activeElement.matches?.(
      [
        ".ProseMirror",
        '[class*="ProseMirror"]',
        '[data-lexical-editor="true"]',
        '[aria-multiline="true"]',
        '[contenteditable="true"]',
        "textarea",
        '[role="textbox"]',
      ].join(", "),
    )
  ) {
    return activeElement;
  }

  return (
    findNearestEditableAncestor(activeElement) ||
    queryAllDeep(
      [
        ".ProseMirror",
        '[class*="ProseMirror"]',
        '[data-lexical-editor="true"]',
        '[data-slate-editor="true"]',
        '[aria-multiline="true"]',
        '[contenteditable="true"]',
        "textarea",
        '[role="textbox"]',
      ].join(", "),
      activeElement,
    )[0] ||
    null
  );
}

function activateEditorSurface(root) {
  root.scrollIntoView({ block: "center", inline: "nearest" });

  const rootRect = root.getBoundingClientRect();
  const pointTarget = document.elementFromPoint(
    rootRect.left + Math.min(rootRect.width / 2, rootRect.width - 8),
    rootRect.top + Math.min(rootRect.height / 2, rootRect.height - 8),
  );
  const clickableTarget =
    findNearestEditableAncestor(pointTarget) ||
    queryAllDeep("p, div, span", root)[0] ||
    root.firstElementChild ||
    root;

  clickableTarget.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  clickableTarget.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
  );
  clickableTarget.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  clickableTarget.focus?.();
}

function queryAllDeep(selector, root = document) {
  const results = [];
  const seen = new Set();
  const queue = [root];

  while (queue.length > 0) {
    const currentRoot = queue.shift();

    if (!currentRoot) {
      continue;
    }

    if (currentRoot.querySelectorAll) {
      for (const match of currentRoot.querySelectorAll(selector)) {
        if (!seen.has(match)) {
          seen.add(match);
          results.push(match);
        }
      }
    }

    const descendants =
      currentRoot instanceof Element || currentRoot instanceof DocumentFragment
        ? currentRoot.querySelectorAll?.("*") || []
        : [];

    for (const element of descendants) {
      if (element.shadowRoot) {
        queue.push(element.shadowRoot);
      }
    }
  }

  return results;
}

function getDeepActiveElement(root = document) {
  let activeElement = root.activeElement || null;

  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }

  return activeElement;
}

function findNearestEditableAncestor(element) {
  let current = element || null;

  while (current) {
    if (
      current.matches?.(
        [
          ".ProseMirror",
          '[class*="ProseMirror"]',
          '[data-lexical-editor="true"]',
          '[data-slate-editor="true"]',
          '[aria-multiline="true"]',
          '[contenteditable="true"]',
          "textarea",
          '[role="textbox"]',
        ].join(", "),
      )
    ) {
      return current;
    }

    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }

    const rootNode = current.getRootNode?.();
    current = rootNode?.host || null;
  }

  return null;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function writeToTarget(target, markup, plainText) {
  target.focus();

  if (target instanceof HTMLTextAreaElement) {
    target.value = plainText;
    dispatchEditorEvents(target, plainText);
    return;
  }

  if (pasteIntoEditor(target, markup, plainText)) {
    dispatchEditorEvents(target, plainText);
    return;
  }

  if (writeUsingEditorCommands(target, markup, plainText)) {
    dispatchEditorEvents(target, plainText);
    return;
  }

  target.innerHTML = markup;
  dispatchEditorEvents(target, plainText);
}

async function insertIntoContentSurface(editor, markup, plainText) {
  const surface = findContentSurface(editor);

  if (!surface) {
    return false;
  }

  activateContentSurface(surface);
  await wait(150);

  const activeElement = getDeepActiveElement();
  const editableActiveElement = findNearestEditableAncestor(activeElement);

  if (editableActiveElement) {
    writeToTarget(editableActiveElement, markup, plainText);
    return true;
  }

  if (surface instanceof HTMLTextAreaElement) {
    writeToTarget(surface, markup, plainText);
    return true;
  }

  if (surface.isContentEditable) {
    writeToTarget(surface, markup, plainText);
    return true;
  }

  surface.innerHTML = markup;
  dispatchEditorEvents(surface, plainText);
  return true;
}

async function syncVisibleEditor(editor, markup, plainText) {
  const target = await resolveEditableTarget(editor);

  if (target) {
    writeToTarget(target, markup, plainText);
    return true;
  }

  return insertIntoContentSurface(editor, markup, plainText);
}

function findContentSurface(root) {
  const rootRect = root.getBoundingClientRect();

  const candidates = queryAllDeep("div, section, article, p, textarea", root)
    .filter((element) => isVisible(element) && !isDisabled(element))
    .filter((element) => !element.querySelector("button"))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      const text = element.textContent?.trim() || "";

      return (
        rect.width >= Math.max(200, rootRect.width * 0.45) &&
        rect.height >= 80 &&
        rect.top >= rootRect.top + 36 &&
        rect.bottom <= rootRect.bottom + 8 &&
        !text.includes("Paragraph") &&
        !text.includes("Heading") &&
        !text.includes("Bold") &&
        !text.includes("Italic")
      );
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (
        rightRect.height * rightRect.width - leftRect.height * leftRect.width
      );
    });

  return candidates[0] || null;
}

function activateContentSurface(surface) {
  surface.scrollIntoView({ block: "nearest", inline: "nearest" });

  const rect = surface.getBoundingClientRect();
  const clickX = rect.left + Math.min(rect.width / 2, rect.width - 12);
  const clickY = rect.top + Math.min(40, Math.max(16, rect.height / 4));
  const clickTarget = document.elementFromPoint(clickX, clickY) || surface;

  clickTarget.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  clickTarget.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
  );
  clickTarget.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  clickTarget.focus?.();
}

function buildMarkup(data) {
  return [
    `<p>${escapeHtml(data.description)}</p>`,
    "<p><strong>Key Features:</strong></p>",
    `<ul>${data.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
  ].join("");
}

function buildPlainText(data) {
  return [
    data.description,
    "",
    "Key Features:",
    ...data.bullets.map((item) => `- ${item}`),
  ].join("\n");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function tryInsertViaHtmlEditor(editorRoot, markup) {
  const toggleButton = findHtmlEditorToggle(editorRoot);

  if (!toggleButton) {
    return false;
  }

  clickElement(toggleButton);
  await wait(200);

  const htmlField = findHtmlEditorField();

  if (!htmlField) {
    return false;
  }

  setFormControlValue(htmlField, markup);

  const confirmButton = findHtmlEditorConfirmButton(htmlField);

  if (confirmButton) {
    clickElement(confirmButton);
    await wait(150);
  } else {
    htmlField.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  }

  return true;
}

function findHtmlEditorToggle(editorRoot) {
  const buttonCandidates = queryAllDeep('button, [role="button"]', editorRoot);

  return (
    buttonCandidates.find((element) => {
      const label = getElementLabel(element);
      return (
        isVisible(element) &&
        !isDisabled(element) &&
        (label.includes("</>") ||
          label.includes("html") ||
          label.includes("code") ||
          label.includes("source"))
      );
    }) || null
  );
}

function findHtmlEditorField() {
  const selectors = [
    'textarea[aria-label*="html" i]',
    'textarea[placeholder*="html" i]',
    'textarea[name*="html" i]',
    "textarea",
    '[contenteditable="true"][aria-label*="html" i]',
    '[contenteditable="true"][data-placeholder*="html" i]',
  ];

  for (const selector of selectors) {
    const matches = queryAllDeep(selector).filter(
      (element) => isVisible(element) && !isDisabled(element),
    );

    const dialogMatch = matches.find((element) => {
      const dialog = element.closest('[role="dialog"], [aria-modal="true"]');
      return Boolean(dialog);
    });

    if (dialogMatch) {
      return dialogMatch;
    }
  }

  return null;
}

function findHtmlEditorConfirmButton(field) {
  const dialog = field.closest('[role="dialog"], [aria-modal="true"]');

  if (!dialog) {
    return null;
  }

  const buttonCandidates = queryAllDeep('button, [role="button"]', dialog);

  return (
    buttonCandidates.find((element) => {
      const label = getElementLabel(element);
      return (
        isVisible(element) &&
        !isDisabled(element) &&
        (label.includes("done") ||
          label.includes("apply") ||
          label.includes("save") ||
          label.includes("insert"))
      );
    }) || null
  );
}

function setFormControlValue(element, value) {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  ) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    dispatchEditorEvents(element, value);
    return;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    placeCaretInEditor(element);
    document.execCommand("insertHTML", false, value);
    dispatchEditorEvents(element, element.textContent || "");
  }
}

function clickElement(element) {
  element.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
  element.dispatchEvent(
    new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
  );
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  element.focus?.();
}

function getElementLabel(element) {
  return [
    element.textContent,
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("title"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .trim();
}

function describeElement(element) {
  if (!element) {
    return "null";
  }

  const parts = [element.tagName?.toLowerCase() || "node"];

  if (element.id) {
    parts.push(`#${element.id}`);
  }

  const className =
    typeof element.className === "string"
      ? element.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "";

  if (className) {
    parts.push(`.${className}`);
  }

  const attrs = [
    ["name", element.getAttribute?.("name")],
    ["type", element.getAttribute?.("type")],
    ["role", element.getAttribute?.("role")],
    ["aria-label", element.getAttribute?.("aria-label")],
    ["data-testid", element.getAttribute?.("data-testid")],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}="${value}"`);

  if (attrs.length > 0) {
    parts.push(attrs.join(" "));
  }

  return parts.join(" ");
}

function inspectEditorState() {
  const editor = findDescriptionEditor();
  const stateField = editor ? findDescriptionStateField(editor) : null;
  const htmlToggle = editor ? findHtmlEditorToggle(editor) : null;
  const editable = editor ? findEditableDescendant(editor) : null;
  const active = getDeepActiveElement();

  return {
    summary: [
      editor ? "description area found" : "description area missing",
      stateField ? `state field: ${describeElement(stateField)}` : "state field: none",
      editable ? `editable node: ${describeElement(editable)}` : "editable node: none",
      htmlToggle ? `html toggle: ${describeElement(htmlToggle)}` : "html toggle: none",
      active ? `active: ${describeElement(active)}` : "active: none",
    ].join(" | "),
    editor: editor ? describeElement(editor) : null,
    stateField: stateField ? describeElement(stateField) : null,
    editable: editable ? describeElement(editable) : null,
    htmlToggle: htmlToggle ? describeElement(htmlToggle) : null,
    active: active ? describeElement(active) : null,
    nearbyFields: editor
      ? findCandidateStateFields(getEditorSearchRoot(editor)).map(describeElement)
      : [],
  };
}

function writeUsingEditorCommands(target, markup, plainText) {
  if (!(target instanceof HTMLElement) || !target.isContentEditable) {
    return false;
  }

  placeCaretInEditor(target);

  const beforeInputSupported = dispatchBeforeInput(target, markup, plainText);
  const insertedHtml = document.execCommand("insertHTML", false, markup);

  if (insertedHtml) {
    return true;
  }

  const insertedText = document.execCommand("insertText", false, plainText);

  if (insertedText) {
    return true;
  }

  if (beforeInputSupported) {
    return false;
  }

  return false;
}

function placeCaretInEditor(target) {
  const selection = window.getSelection();

  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(target);
  range.deleteContents();
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchBeforeInput(target, markup, plainText) {
  try {
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
      data: plainText,
    });

    target.dispatchEvent(event);
    return true;
  } catch (_error) {
    return false;
  }
}

function dispatchEditorEvents(target, plainText) {
  target.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: plainText,
      inputType: "insertText",
    }),
  );
  target.dispatchEvent(new Event("change", { bubbles: true }));
  target.dispatchEvent(new Event("blur", { bubbles: true }));
}

function pasteIntoEditor(target, markup, plainText) {
  if (!(target instanceof HTMLElement) || !target.isContentEditable) {
    return false;
  }

  placeCaretInEditor(target);

  const dataTransfer = createEditorDataTransfer(markup, plainText);
  let pasteHandled = false;

  if (dataTransfer) {
    try {
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
      });

      pasteHandled = target.dispatchEvent(pasteEvent);
    } catch (_error) {
      pasteHandled = false;
    }
  }

  if (pasteHandled) {
    return true;
  }

  try {
    const beforeInputEvent = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: plainText,
      dataTransfer: dataTransfer || undefined,
    });

    target.dispatchEvent(beforeInputEvent);
  } catch (_error) {
    // Ignore unsupported constructor fields and continue with command fallback.
  }

  return false;
}

function createEditorDataTransfer(markup, plainText) {
  if (typeof DataTransfer === "undefined") {
    return null;
  }

  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/html", markup);
    dataTransfer.setData("text/plain", plainText);
    return dataTransfer;
  } catch (_error) {
    return null;
  }
}
