const MARKED_OPTIONS = {
  breaks: true,
  gfm: true
};

export function renderMarkdownToHtml(markdownText) {
  if (!markdownText) return "";
  const normalized = normalizeMathDelimiters(markdownText);
  const markedLib = typeof window !== "undefined" ? window.marked : undefined;
  if (typeof markedLib === "undefined") {
    return escapeHtml(normalized);
  }
  markedLib.setOptions(MARKED_OPTIONS);
  return markedLib.parse(normalized);
}

export function renderRichContent(rawText) {
  const fragment = document.createDocumentFragment();
  const blocks = mergeAdjacentTextBlocks(splitIntoBlocks(cleanLooseLines(rawText || "")));
  blocks.forEach((block) => {
    if (block.type === "math") {
      const mathEl = document.createElement("div");
      mathEl.className = "katex-display";
      const katexLib = typeof window !== "undefined" ? window.katex : undefined;
      if (katexLib) {
        try {
          katexLib.render(block.content, mathEl, {
            displayMode: true,
            throwOnError: false,
            strict: "ignore"
          });
        } catch {
          mathEl.textContent = block.raw;
        }
      } else {
        mathEl.textContent = block.raw;
      }
      fragment.appendChild(mathEl);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "text-block";
    wrapper.innerHTML = renderMarkdownToHtml(block.content);
    normalizePunctuationSpacingInText(wrapper);

    // Render inline math inside text blocks.
    renderMathInContainer(wrapper);
    fragment.appendChild(wrapper);
  });
  return fragment;
}

function cleanLooseLines(text) {
  const lines = text.split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const prev = output[output.length - 1] || "";
    if (trimmed.length === 0) {
      if (prev !== "") output.push("");
      continue;
    }
    if (/^[·•,.;:!?\.\-–—]+$/.test(trimmed)) {
      // Drop stray punctuation-only lines.
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

function normalizePunctuationSpacingInText(container) {
  const textNodes = collectTextNodes(container);
  textNodes.forEach((node) => {
    const value = node.nodeValue || "";
    const normalized = value.replace(/\s+([,.;:!?)\]\}])/g, "$1");
    if (normalized !== value) {
      node.nodeValue = normalized;
    }
  });
}

function mergeAdjacentTextBlocks(blocks) {
  const merged = [];
  blocks.forEach((block) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === "text" && block.type === "text") {
      prev.content = `${prev.content}\n${block.content}`;
    } else {
      merged.push({ ...block });
    }
  });
  return merged;
}

export function renderMathInContainer(container) {
  if (!container) return;
  const renderMath = typeof window !== "undefined" ? window.renderMathInElement : undefined;
  const katexLib = typeof window !== "undefined" ? window.katex : undefined;

  if (katexLib) {
    renderStandaloneDollarBlocks(container, katexLib);
  }
  if (typeof renderMath === "function") {
    renderMath(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "\\(", right: "\\)", display: false }
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      throwOnError: false,
      strict: "ignore"
    });
    return;
  }

  if (!katexLib) return;

  const textNodes = collectTextNodes(container);
  textNodes.forEach((node) => {
    const replaced = replaceLatexInText(node, katexLib);
    if (replaced) {
      node.parentNode.replaceChild(replaced, node);
    }
  });
}

function collectTextNodes(container) {
  const nodes = [];
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code, script, style, textarea")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }
  return nodes;
}

function replaceLatexInText(textNode, katexLib) {
  const text = textNode.nodeValue;
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
  let match;
  let lastIndex = 0;
  let hasMatch = false;
  const fragment = document.createDocumentFragment();

  while ((match = pattern.exec(text)) !== null) {
    hasMatch = true;
    const matchStart = match.index;
    const matchText = match[0];
    const latex = match[1] || match[2] || "";
    const isDisplay = matchText.startsWith("$$");

    if (matchStart > lastIndex) {
      fragment.appendChild(
        document.createTextNode(text.slice(lastIndex, matchStart))
      );
    }

    const wrapper = document.createElement(isDisplay ? "div" : "span");
    wrapper.className = isDisplay ? "katex-display" : "katex-inline";
    try {
      katexLib.render(latex, wrapper, {
        displayMode: isDisplay,
        throwOnError: false
      });
      fragment.appendChild(wrapper);
    } catch {
      fragment.appendChild(document.createTextNode(matchText));
    }

    lastIndex = matchStart + matchText.length;
  }

  if (!hasMatch) return null;

  if (lastIndex < text.length) {
    fragment.appendChild(
      document.createTextNode(text.slice(lastIndex))
    );
  }

  return fragment;
}

function normalizeMathDelimiters(text) {
  let normalized = normalizeMultilineDollarBlocks(text);
  const parts = normalized.split("```");
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) continue; // inside fenced code block
    parts[i] = normalizeInlineDelimiters(parts[i]);
  }
  return parts.join("```");
}

function normalizeInlineDelimiters(chunk) {
  const segments = chunk.split("`");
  for (let i = 0; i < segments.length; i += 1) {
    if (i % 2 === 1) continue; // inline code
    segments[i] = segments[i]
      .replace(/\\\[/g, "$$")
      .replace(/\\\]/g, "$$")
      .replace(/\\\(/g, "$")
      .replace(/\\\)/g, "$");
  }
  return segments.join("`");
}

function normalizeMultilineDollarBlocks(text) {
  // Convert blocks like:
  // $
  //   ...math...
  // $
  // into $$...$$ before Markdown runs.
  const lines = text.split(/\r?\n/);
  const output = [];
  let inBlock = false;
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    output.push(`$$${body}$$`);
    buffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const isFence = trimmed === "$" || trimmed === "$$";

    if (isFence) {
      if (!inBlock) {
        inBlock = true;
      } else {
        flush();
        inBlock = false;
      }
      continue;
    }

    if (inBlock) {
      buffer.push(line);
    } else {
      output.push(line);
    }
  }

  if (inBlock) {
    // Unclosed block: restore original content.
    output.push("$");
    output.push(...buffer);
  }

  return output.join("\n");
}

function renderStandaloneDollarBlocks(container, katexLib) {
  const children = Array.from(container.childNodes);
  let i = 0;

  while (i < children.length) {
    const node = children[i];
    if (!isStandaloneDollarParagraph(node)) {
      i += 1;
      continue;
    }

    const fence = node.textContent.trim(); // "$" or "$$"
    const startIndex = i;
    let j = i + 1;
    const buffer = [];
    let closed = false;

    while (j < children.length) {
      const current = children[j];
      if (isStandaloneDollarParagraph(current)) {
        const endFence = current.textContent.trim();
        if (endFence === fence) {
          closed = true;
          break;
        }
      }
      buffer.push(current);
      j += 1;
    }

    if (!closed) {
      i += 1;
      continue;
    }

    const latex = buffer.map((n) => (n.textContent || "")).join("\n").trim();
    const wrapper = document.createElement("div");
    wrapper.className = "katex-display";
    try {
      katexLib.render(latex, wrapper, {
        displayMode: true,
        throwOnError: false,
        strict: "ignore"
      });
    } catch {
      i += 1;
      continue;
    }

    const endIndex = j;
    for (let k = startIndex; k <= endIndex; k += 1) {
      if (children[k] && children[k].parentNode) {
        children[k].parentNode.removeChild(children[k]);
      }
    }

    container.insertBefore(wrapper, children[endIndex + 1] || null);
    children.splice(startIndex, endIndex - startIndex + 1, wrapper);
    i = startIndex + 1;
  }
}

function isStandaloneDollarParagraph(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = node.tagName.toLowerCase();
  if (tag !== "p" && tag !== "div") return false;
  const text = (node.textContent || "").trim();
  return text === "$" || text === "$$";
}

function splitIntoBlocks(text) {
  const normalized = normalizeMathDelimiters(text);
  const blocks = [];

  // First, handle standalone $ / $$ fences on their own lines.
  const lines = normalized.split(/\r?\n/);
  let inFence = false;
  let fenceBuffer = [];

  const flushFence = () => {
    const content = fenceBuffer.join("\n").trim();
    if (content) {
      blocks.push({ type: "math", content, raw: `$${content}$` });
    }
    fenceBuffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const isFence = trimmed === "$" || trimmed === "$$";
    if (isFence) {
      if (!inFence) {
        inFence = true;
      } else {
        flushFence();
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      fenceBuffer.push(line);
    } else {
      blocks.push({ type: "text", content: line });
    }
  }
  if (inFence) {
    blocks.push({ type: "text", content: ["$", ...fenceBuffer].join("\n") });
  }

  // Re-join text lines and then split on inline/block delimiters.
  const merged = [];
  let textAccumulator = [];
  blocks.forEach((block) => {
    if (block.type === "text") {
      textAccumulator.push(block.content);
    } else {
      if (textAccumulator.length > 0) {
        merged.push({ type: "text", content: textAccumulator.join("\n") });
        textAccumulator = [];
      }
      merged.push(block);
    }
  });
  if (textAccumulator.length > 0) {
    merged.push({ type: "text", content: textAccumulator.join("\n") });
  }

  const finalBlocks = [];
  const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\n$]+?)\$|\\\(([\s\S]+?)\\\)/g;

  merged.forEach((block) => {
    if (block.type === "math") {
      finalBlocks.push(block);
      return;
    }
    const text = block.content;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const matchStart = match.index;
      if (matchStart > lastIndex) {
        finalBlocks.push({ type: "text", content: text.slice(lastIndex, matchStart) });
      }
      const latex = match[1] || match[2] || match[3] || match[4] || "";
      finalBlocks.push({ type: "math", content: latex.trim(), raw: match[0] });
      lastIndex = matchStart + match[0].length;
    }
    if (lastIndex < text.length) {
      finalBlocks.push({ type: "text", content: text.slice(lastIndex) });
    }
  });

  return finalBlocks.filter((block) => block.content && block.content.trim() !== "");
}


export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
