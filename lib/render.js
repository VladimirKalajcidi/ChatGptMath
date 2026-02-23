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
  const sanitized = stripUnsupportedGeometryBlocks(rawText || "");
  const blocks = mergeAdjacentTextBlocks(splitIntoBlocks(cleanLooseLines(sanitized)));
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

    const segments = splitTextAndGraphicBlocks(block.content);
    segments.forEach((segment) => {
      if (segment.type === "graphic") {
        const graphicEl = renderLatexGraphicBlock(segment.content);
        if (graphicEl) {
          fragment.appendChild(graphicEl);
          return;
        }
      }
      if (!segment.content || !segment.content.trim()) return;
      const wrapper = document.createElement("div");
      wrapper.className = "text-block";
      wrapper.innerHTML = renderMarkdownToHtml(segment.content);
      normalizePunctuationSpacingInText(wrapper);
      renderMathInContainer(wrapper);
      fragment.appendChild(wrapper);

      const autoGraphEl = renderAutoGraphFromText(segment.content);
      if (autoGraphEl) {
        fragment.appendChild(autoGraphEl);
      }
    });
  });
  return fragment;
}

function stripUnsupportedGeometryBlocks(text) {
  return String(text || "").replace(
    /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g,
    "\nГеометрические фигуры в этом чате сейчас не поддерживаются.\n"
  );
}

export async function renderExternalTikzInContainer(container, { rendererUrl, rendererToken } = {}) {
  if (!container || !rendererUrl) return;
  const targets = Array.from(container.querySelectorAll("[data-latex-source]"));
  if (targets.length === 0) return;

  for (const node of targets) {
    const encoded = node.getAttribute("data-latex-source");
    const latex = decodeUtf8Base64(encoded);
    if (!latex || !latex.includes("\\begin{tikzpicture}")) continue;

    if (node.dataset.externalRenderDone === "1") continue;
    const validation = validateTikzSnippet(latex);
    if (!validation.ok) {
      node.dataset.externalRenderDone = "0";
      upsertTikzRenderNote(node, `TikZ check failed: ${validation.reason}`);
      continue;
    }

    node.dataset.externalRenderDone = "pending";
    upsertTikzRenderNote(node, "");

    try {
      const svg = await requestCompiledTikzSvg(rendererUrl, rendererToken, validation.normalized);
      if (!svg || typeof svg !== "string" || !svg.includes("<svg")) {
        node.dataset.externalRenderDone = "0";
        upsertTikzRenderNote(node, "Renderer returned no SVG.");
        continue;
      }
      node.innerHTML = normalizeCompiledSvg(svg);
      node.dataset.externalRenderDone = "1";
      upsertTikzRenderNote(node, "");
    } catch (error) {
      node.dataset.externalRenderDone = "0";
      upsertTikzRenderNote(node, `TikZ render failed: ${error?.message || "unknown error"}`);
    }
  }
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
    if (/^\\documentclass\b/i.test(trimmed)) continue;
    if (/^\\usepackage\b/i.test(trimmed)) continue;
    if (/^\\begin\{document\}\s*$/i.test(trimmed)) continue;
    if (/^\\end\{document\}\s*$/i.test(trimmed)) continue;
    if (/^(here is|вот)\s+.*(latex|tikz|код).*/i.test(trimmed)) continue;
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
        { left: "$", right: "$", display: false },
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
  const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;

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
      const latex = match[1] || match[2] || "";
      finalBlocks.push({ type: "math", content: latex.trim(), raw: match[0] });
      lastIndex = matchStart + match[0].length;
    }
    if (lastIndex < text.length) {
      finalBlocks.push({ type: "text", content: text.slice(lastIndex) });
    }
  });

  return finalBlocks.filter((block) => block.content && block.content.trim() !== "");
}

function splitTextAndGraphicBlocks(text) {
  const pattern = /\\begin\{axis\}[\s\S]*?\\end\{axis\}|\\begin\{functiongraph\}[\s\S]*?\\end\{functiongraph\}/g;
  const blocks = [];
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      blocks.push({ type: "text", content: text.slice(lastIndex, start) });
    }
    blocks.push({ type: "graphic", content: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    blocks.push({ type: "text", content: text.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content: text }];
}

function renderLatexGraphicBlock(latex) {
  if (!latex) return null;
  if (latex.includes("\\begin{axis}")) {
    const el = renderAxisPlot(latex);
    if (el) setLatexSource(el, latex);
    return el;
  }
  if (latex.includes("\\begin{functiongraph}")) {
    const el = renderFunctionGraph(latex);
    if (el) setLatexSource(el, latex);
    return el;
  }
  return null;
}

function renderAxisPlot(latex) {
  const optionsRaw = (latex.match(/\\begin\{axis\}\[([\s\S]*?)\]/) || [])[1] || "";
  const options = parseOptionList(optionsRaw);
  const plots = [];
  const plotRegex = /\\addplot(?:\[(.*?)\])?\s*\{([^}]*)\}\s*;/g;
  let match;
  while ((match = plotRegex.exec(latex)) !== null) {
    plots.push({
      expr: (match[2] || "").trim(),
      options: parseOptionList(match[1] || "")
    });
  }
  if (plots.length === 0) return null;

  const xMin = toFiniteNumber(options.xmin, -10);
  const xMax = toFiniteNumber(options.xmax, 10);
  const yMin = toFiniteNumber(options.ymin, -10);
  const yMax = toFiniteNumber(options.ymax, 10);
  return createFunctionSvg({
    xMin,
    xMax,
    yMin,
    yMax,
    curves: plots.map((plot) => ({
      expr: normalizeLatexExpression(plot.expr),
      domainMin: toFiniteNumber((plot.options.domain || "").split(":")[0], xMin),
      domainMax: toFiniteNumber((plot.options.domain || "").split(":")[1], xMax)
    }))
  });
}

function renderFunctionGraph(latex) {
  const bodyMatch = latex.match(/\\begin\{functiongraph\}([\s\S]*?)\\end\{functiongraph\}/);
  const body = bodyMatch ? bodyMatch[1] : "";
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const exprLine = lines.find((line) => /^y\s*=|^f\(x\)\s*=|^plot:/i.test(line)) || lines[0];
  const exprRaw = exprLine.replace(/^plot:/i, "").replace(/^f\(x\)\s*=/i, "").replace(/^y\s*=/i, "").trim();
  let xMin = -10;
  let xMax = 10;
  let yMin = -10;
  let yMax = 10;
  lines.forEach((line) => {
    const domainMatch = line.match(/^domain\s*=\s*\[\s*([^,]+)\s*,\s*([^\]]+)\s*\]/i);
    if (domainMatch) {
      xMin = toFiniteNumber(domainMatch[1], xMin);
      xMax = toFiniteNumber(domainMatch[2], xMax);
    }
    const rangeMatch = line.match(/^range\s*=\s*\[\s*([^,]+)\s*,\s*([^\]]+)\s*\]/i);
    if (rangeMatch) {
      yMin = toFiniteNumber(rangeMatch[1], yMin);
      yMax = toFiniteNumber(rangeMatch[2], yMax);
    }
  });

  return createFunctionSvg({
    xMin,
    xMax,
    yMin,
    yMax,
    curves: [{ expr: normalizeLatexExpression(exprRaw), domainMin: xMin, domainMax: xMax }]
  });
}

function createFunctionSvg({ xMin, xMax, yMin, yMax, curves }) {
  const width = 460;
  const height = 290;
  const pad = 34;
  const spanX = Math.max(1e-6, xMax - xMin);
  const spanY = Math.max(1e-6, yMax - yMin);
  const toX = (x) => pad + ((x - xMin) / spanX) * (width - 2 * pad);
  const toY = (y) => height - pad - ((y - yMin) / spanY) * (height - 2 * pad);
  const svgNs = "http://www.w3.org/2000/svg";

  const wrapper = document.createElement("div");
  wrapper.className = "latex-graphic";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "latex-graphic-svg");

  const bg = document.createElementNS(svgNs, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("rx", "12");
  bg.setAttribute("class", "latex-graphic-bg");
  svg.appendChild(bg);

  const xStep = chooseNiceStep(spanX / 7);
  const yStep = chooseNiceStep(spanY / 6);
  const xTicks = generateTicks(xMin, xMax, xStep);
  const yTicks = generateTicks(yMin, yMax, yStep);

  xTicks.forEach((value) => {
    const x = toX(value);
    const grid = document.createElementNS(svgNs, "line");
    grid.setAttribute("x1", String(x));
    grid.setAttribute("y1", String(pad));
    grid.setAttribute("x2", String(x));
    grid.setAttribute("y2", String(height - pad));
    grid.setAttribute("class", "latex-grid");
    svg.appendChild(grid);
  });
  yTicks.forEach((value) => {
    const y = toY(value);
    const grid = document.createElementNS(svgNs, "line");
    grid.setAttribute("x1", String(pad));
    grid.setAttribute("y1", String(y));
    grid.setAttribute("x2", String(width - pad));
    grid.setAttribute("y2", String(y));
    grid.setAttribute("class", "latex-grid");
    svg.appendChild(grid);
  });

  const axisXValue = yMin <= 0 && yMax >= 0 ? 0 : yMin;
  const axisYValue = xMin <= 0 && xMax >= 0 ? 0 : xMin;
  const axisXPos = toY(axisXValue);
  const axisYPos = toX(axisYValue);

  xTicks.forEach((value) => {
    const x = toX(value);
    const tick = document.createElementNS(svgNs, "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("y1", String(axisXPos - 4));
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y2", String(axisXPos + 4));
    tick.setAttribute("class", "latex-tick");
    svg.appendChild(tick);

    if (Math.abs(value) < 1e-9) return;
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", String(x));
    label.setAttribute("y", String(Math.min(height - 8, Math.max(14, axisXPos + 15))));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "latex-tick-label");
    label.textContent = formatTickLabel(value, xStep);
    svg.appendChild(label);
  });

  yTicks.forEach((value) => {
    const y = toY(value);
    const tick = document.createElementNS(svgNs, "line");
    tick.setAttribute("x1", String(axisYPos - 4));
    tick.setAttribute("y1", String(y));
    tick.setAttribute("x2", String(axisYPos + 4));
    tick.setAttribute("y2", String(y));
    tick.setAttribute("class", "latex-tick");
    svg.appendChild(tick);

    if (Math.abs(value) < 1e-9) return;
    const label = document.createElementNS(svgNs, "text");
    label.setAttribute("x", String(Math.min(width - 10, Math.max(8, axisYPos - 8))));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "latex-tick-label");
    label.textContent = formatTickLabel(value, yStep);
    svg.appendChild(label);
  });

  if (xMin <= 0 && xMax >= 0) {
    const yAxis = document.createElementNS(svgNs, "line");
    yAxis.setAttribute("x1", String(toX(0)));
    yAxis.setAttribute("y1", String(pad));
    yAxis.setAttribute("x2", String(toX(0)));
    yAxis.setAttribute("y2", String(height - pad));
    yAxis.setAttribute("class", "latex-axis");
    svg.appendChild(yAxis);
  }
  if (yMin <= 0 && yMax >= 0) {
    const xAxis = document.createElementNS(svgNs, "line");
    xAxis.setAttribute("x1", String(pad));
    xAxis.setAttribute("y1", String(toY(0)));
    xAxis.setAttribute("x2", String(width - pad));
    xAxis.setAttribute("y2", String(toY(0)));
    xAxis.setAttribute("class", "latex-axis");
    svg.appendChild(xAxis);
  }

  curves.forEach((curve, index) => {
    const points = [];
    const samples = 180;
    for (let i = 0; i <= samples; i += 1) {
      const x = curve.domainMin + ((curve.domainMax - curve.domainMin) * i) / samples;
      const y = safeEvaluateExpression(curve.expr, x);
      if (!Number.isFinite(y)) continue;
      points.push(`${toX(x).toFixed(2)},${toY(y).toFixed(2)}`);
    }
    if (points.length < 2) return;
    const poly = document.createElementNS(svgNs, "polyline");
    poly.setAttribute("points", points.join(" "));
    poly.setAttribute("fill", "none");
    poly.setAttribute("class", index % 2 === 0 ? "latex-curve" : "latex-curve-alt");
    svg.appendChild(poly);
  });

  if (Array.isArray(curves.points) && curves.points.length >= 2) {
    const sorted = uniqueSortedPoints(curves.points);
    const sampled = sampleSmoothCurve(sorted);
    const line = document.createElementNS(svgNs, "polyline");
    line.setAttribute(
      "points",
      sampled.map((p) => `${toX(p.x).toFixed(2)},${toY(p.y).toFixed(2)}`).join(" ")
    );
    line.setAttribute("class", "latex-points-line");
    line.setAttribute("fill", "none");
    svg.appendChild(line);
    sorted.forEach((p) => {
      const dot = document.createElementNS(svgNs, "circle");
      dot.setAttribute("cx", String(toX(p.x)));
      dot.setAttribute("cy", String(toY(p.y)));
      dot.setAttribute("r", "3.2");
      dot.setAttribute("class", "latex-point");
      svg.appendChild(dot);
    });
  }

  wrapper.appendChild(svg);
  return wrapper;
}

function uniqueSortedPoints(points) {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x);
  const unique = [];
  sorted.forEach((p) => {
    const prev = unique[unique.length - 1];
    if (!prev || Math.abs(prev.x - p.x) > 1e-9) {
      unique.push({ x: p.x, y: p.y });
    }
  });
  return unique;
}

function sampleSmoothCurve(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  if (points.length === 2) return points;

  const spline = buildNaturalCubicSpline(points);
  if (!spline) return points;

  const sampled = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const x0 = points[i].x;
    const x1 = points[i + 1].x;
    const steps = 32;
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      sampled.push({ x, y: evalNaturalSplineAt(spline, x, i) });
    }
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

function buildNaturalCubicSpline(points) {
  const n = points.length;
  if (n < 3) return null;
  const x = points.map((p) => p.x);
  const y = points.map((p) => p.y);
  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    h[i] = x[i + 1] - x[i];
    if (h[i] <= 1e-12) return null;
  }

  const alpha = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    alpha[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
  }

  const l = new Array(n).fill(0);
  const mu = new Array(n).fill(0);
  const z = new Array(n).fill(0);
  const c = new Array(n).fill(0);
  const b = new Array(n - 1).fill(0);
  const d = new Array(n - 1).fill(0);
  const a = y.slice(0, n - 1);

  l[0] = 1;
  for (let i = 1; i < n - 1; i += 1) {
    l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
    if (Math.abs(l[i]) < 1e-12) return null;
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  l[n - 1] = 1;
  c[n - 1] = 0;

  for (let j = n - 2; j >= 0; j -= 1) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = ((y[j + 1] - y[j]) / h[j]) - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }

  return { x, a, b, c, d };
}

function evalNaturalSplineAt(spline, x, fallbackIndex = 0) {
  const n = spline.x.length;
  let i = Math.min(Math.max(fallbackIndex, 0), n - 2);
  if (x < spline.x[i] || x > spline.x[i + 1]) {
    i = findSplineSegment(spline.x, x);
  }
  const dx = x - spline.x[i];
  return spline.a[i] + spline.b[i] * dx + spline.c[i] * dx * dx + spline.d[i] * dx * dx * dx;
}

function findSplineSegment(xs, x) {
  let lo = 0;
  let hi = xs.length - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]) hi = mid - 1;
    else if (x > xs[mid + 1]) lo = mid + 1;
    else return mid;
  }
  return Math.min(Math.max(lo, 0), xs.length - 2);
}

function renderTikzGeometry(latex) {
  const width = 460;
  const height = 290;
  const pad = 24;
  const drawMatches = [
    ...latex.matchAll(
      /\\draw(?:\[[^\]]*\])?\s*((?:\([^)]+\)\s*--\s*)+\([^)]+\))(?:\s*--\s*cycle)?\s*;/g
    )
  ];
  const rectangleMatches = [
    ...latex.matchAll(/\\draw(?:\[[^\]]*\])?\s*\(([^)]+)\)\s*rectangle\s*\(([^)]+)\)\s*;/g)
  ];
  const circleMatches = [
    ...latex.matchAll(
      /\\draw(?:\[[^\]]*\])?\s*\(([^)]+)\)\s*circle(?:\s*\(\s*([^)]+)\s*\)|\s*\[\s*radius\s*=\s*([^\]]+)\s*\])\s*;/g
    )
  ];
  const nodeMatches = [...latex.matchAll(/\\node(?:\[[^\]]*\])?\s*at\s*\(([^)]+)\)\s*\{\s*([^}]*)\s*\}\s*;/g)];
  if (drawMatches.length === 0 && rectangleMatches.length === 0 && circleMatches.length === 0 && nodeMatches.length === 0) {
    return null;
  }

  const segments = [];
  const circles = [];
  const allPoints = [];
  drawMatches.forEach((match) => {
    const coords = [...match[1].matchAll(/\(([^)]+)\)/g)]
      .map((m) => parseCoord(m[1]))
      .filter(Boolean);
    for (let i = 0; i < coords.length - 1; i += 1) {
      segments.push([coords[i], coords[i + 1]]);
      allPoints.push(coords[i], coords[i + 1]);
    }
    if (/--\s*cycle\s*;/i.test(match[0]) && coords.length >= 3) {
      segments.push([coords[coords.length - 1], coords[0]]);
      allPoints.push(coords[coords.length - 1], coords[0]);
    }
  });
  rectangleMatches.forEach((match) => {
    const p1 = parseCoord(match[1]);
    const p3 = parseCoord(match[2]);
    if (!p1 || !p3) return;
    const p2 = { x: p3.x, y: p1.y };
    const p4 = { x: p1.x, y: p3.y };
    segments.push([p1, p2], [p2, p3], [p3, p4], [p4, p1]);
    allPoints.push(p1, p2, p3, p4);
  });
  circleMatches.forEach((match) => {
    const center = parseCoord(match[1]);
    const radius = parseCircleRadius(match[2] || match[3] || "");
    if (!center || !Number.isFinite(radius) || radius <= 0) return;
    circles.push({ center, radius });
    allPoints.push(
      { x: center.x - radius, y: center.y },
      { x: center.x + radius, y: center.y },
      { x: center.x, y: center.y - radius },
      { x: center.x, y: center.y + radius }
    );
  });
  const nodes = nodeMatches
    .map((match) => ({ point: parseCoord(match[1]), label: (match[2] || "").trim() }))
    .filter((node) => node.point);
  nodes.forEach((node) => allPoints.push(node.point));
  if (allPoints.length === 0) return null;

  const xValues = allPoints.map((p) => p.x);
  const yValues = allPoints.map((p) => p.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const spanX = Math.max(1e-6, maxX - minX);
  const spanY = Math.max(1e-6, maxY - minY);
  const plotW = width - 2 * pad;
  const plotH = height - 2 * pad;
  const scale = Math.min(plotW / spanX, plotH / spanY);
  const usedW = spanX * scale;
  const usedH = spanY * scale;
  const left = pad + (plotW - usedW) / 2;
  const top = pad + (plotH - usedH) / 2;
  const toX = (x) => left + (x - minX) * scale;
  const toY = (y) => top + (maxY - y) * scale;

  const svgNs = "http://www.w3.org/2000/svg";
  const wrapper = document.createElement("div");
  wrapper.className = "latex-graphic";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "latex-graphic-svg");

  const bg = document.createElementNS(svgNs, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("rx", "12");
  bg.setAttribute("class", "latex-graphic-bg");
  svg.appendChild(bg);

  segments.forEach(([a, b]) => {
    const line = document.createElementNS(svgNs, "line");
    line.setAttribute("x1", String(toX(a.x)));
    line.setAttribute("y1", String(toY(a.y)));
    line.setAttribute("x2", String(toX(b.x)));
    line.setAttribute("y2", String(toY(b.y)));
    line.setAttribute("class", "latex-geom-line");
    svg.appendChild(line);
  });

  circles.forEach(({ center, radius }) => {
    const circle = document.createElementNS(svgNs, "circle");
    circle.setAttribute("cx", String(toX(center.x)));
    circle.setAttribute("cy", String(toY(center.y)));
    circle.setAttribute("r", String(radius * scale));
    circle.setAttribute("class", "latex-geom-circle");
    svg.appendChild(circle);
  });

  nodes.forEach(({ point, label }) => {
    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("cx", String(toX(point.x)));
    dot.setAttribute("cy", String(toY(point.y)));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "latex-geom-point");
    svg.appendChild(dot);
    if (label) {
      const text = document.createElementNS(svgNs, "text");
      text.setAttribute("x", String(toX(point.x) + 6));
      text.setAttribute("y", String(toY(point.y) - 6));
      text.setAttribute("class", "latex-geom-label");
      text.textContent = label;
      svg.appendChild(text);
    }
  });

  wrapper.appendChild(svg);
  return wrapper;
}

function parseCoord(raw) {
  const parts = String(raw || "").split(",").map((part) => part.trim());
  if (parts.length !== 2) return null;
  const x = parseCoordValue(parts[0]);
  const y = parseCoordValue(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function parseCoordValue(raw) {
  const match = String(raw || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  return Number(match[0]);
}

function parseCircleRadius(raw) {
  const match = String(raw || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  return Math.abs(Number(match[0]));
}

function setLatexSource(element, latex) {
  if (!element || !latex) return;
  element.setAttribute("data-latex-source", encodeUtf8Base64(String(latex)));
}

async function requestCompiledTikzSvg(rendererUrl, rendererToken, latex) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {
      "Content-Type": "application/json"
    };
    if (rendererToken) {
      headers.Authorization = `Bearer ${rendererToken}`;
    }
    const response = await fetch(rendererUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        latex,
        tikz: latex,
        document: buildStandaloneTikzDocument(latex),
        inputFormat: "tikz-snippet",
        output: "svg"
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await safeReadRendererError(response);
      throw new Error(errorText || `HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("image/svg+xml") || contentType.includes("text/plain")) {
      return await response.text();
    }
    const payload = await response.json();
    if (typeof payload === "string") return payload;
    if (payload && typeof payload.svg === "string") return payload.svg;
    if (payload && payload.data && typeof payload.data.svg === "string") return payload.data.svg;
    if (payload && typeof payload.error === "string") {
      throw new Error(payload.error);
    }
    if (payload && payload.error && typeof payload.error.message === "string") {
      throw new Error(payload.error.message);
    }
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCompiledSvg(svgText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== "svg") return "";
  svg.setAttribute("class", "latex-graphic-svg");
  if (!svg.getAttribute("viewBox")) {
    const width = Number(svg.getAttribute("width")) || 460;
    const height = Number(svg.getAttribute("height")) || 290;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  return svg.outerHTML;
}

function encodeUtf8Base64(value) {
  try {
    const bytes = new TextEncoder().encode(String(value || ""));
    let binary = "";
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  } catch {
    return "";
  }
}

function decodeUtf8Base64(value) {
  try {
    const binary = atob(String(value || ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function validateTikzSnippet(input) {
  const latex = String(input || "").trim();
  if (!latex) return { ok: false, reason: "empty block", normalized: "" };

  const beginCount = (latex.match(/\\begin\{tikzpicture\}/g) || []).length;
  const endCount = (latex.match(/\\end\{tikzpicture\}/g) || []).length;
  if (beginCount === 0 || endCount === 0) {
    return { ok: false, reason: "missing \\begin{tikzpicture} or \\end{tikzpicture}", normalized: latex };
  }
  if (beginCount !== endCount) {
    return { ok: false, reason: "unbalanced tikzpicture begin/end", normalized: latex };
  }

  const braceState = checkBalancedBraces(latex);
  if (!braceState.ok) {
    return { ok: false, reason: braceState.reason, normalized: latex };
  }

  const normalized = latex
    .replace(/\s+/g, " ")
    .replace(/;\s*/g, ";\n")
    .replace(/\\begin\{tikzpicture\}\s*/g, "\\begin{tikzpicture}\n")
    .replace(/\s*\\end\{tikzpicture\}/g, "\n\\end{tikzpicture}")
    .trim();

  return { ok: true, reason: "", normalized };
}

function checkBalancedBraces(src) {
  let depth = 0;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth < 0) return { ok: false, reason: "extra closing brace }" };
  }
  if (depth !== 0) return { ok: false, reason: "unbalanced { } braces" };
  return { ok: true, reason: "" };
}

function buildStandaloneTikzDocument(snippet) {
  const body = String(snippet || "").trim();
  return [
    "\\documentclass[tikz,border=2pt]{standalone}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T2A]{fontenc}",
    "\\usepackage[russian,english]{babel}",
    "\\usepackage{tikz}",
    "\\begin{document}",
    body,
    "\\end{document}"
  ].join("\n");
}

function upsertTikzRenderNote(node, message) {
  if (!node || !node.parentElement) return;
  const parent = node.parentElement;
  let note = parent.querySelector(".latex-compile-note");
  const text = String(message || "").trim();
  if (!text) {
    if (note) note.remove();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.className = "latex-compile-note";
    parent.appendChild(note);
  }
  note.textContent = text;
}

async function safeReadRendererError(response) {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === "string") return payload.error;
    if (payload && payload.error && typeof payload.error.message === "string") return payload.error.message;
    return JSON.stringify(payload);
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}

function parseOptionList(raw) {
  const options = {};
  String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const eq = part.indexOf("=");
      if (eq < 0) return;
      const key = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      options[key] = value;
    });
  return options;
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function chooseNiceStep(target) {
  const safe = Math.max(1e-9, Math.abs(target));
  const exponent = Math.floor(Math.log10(safe));
  const fraction = safe / (10 ** exponent);
  let niceFraction = 1;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * (10 ** exponent);
}

function generateTicks(min, max, step) {
  const ticks = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 0.5; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  if (!ticks.some((v) => Math.abs(v) < step * 1e-4) && min <= 0 && max >= 0) {
    ticks.push(0);
  }
  return ticks.sort((a, b) => a - b);
}

function formatTickLabel(value, step) {
  if (Math.abs(step) >= 1) return String(Math.round(value));
  const decimals = Math.min(4, Math.max(1, Math.ceil(-Math.log10(Math.abs(step)))));
  return String(Number(value.toFixed(decimals)));
}

function renderAutoGraphFromText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (!/(plot|graph|coordinate|координат|график)/i.test(lowered)) return null;

  const normalized = raw
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, "");
  const points = [];
  const pointRegex = /\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/g;
  let match;
  while ((match = pointRegex.exec(normalized)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x, y });
  }
  if (points.length < 2) return null;

  const uniq = [];
  const seen = new Set();
  points.forEach((p) => {
    const key = `${p.x}:${p.y}`;
    if (seen.has(key)) return;
    seen.add(key);
    uniq.push(p);
  });
  if (uniq.length < 2) return null;

  const xs = uniq.map((p) => p.x);
  const ys = uniq.map((p) => p.y);
  const xMin = Math.min(...xs) - 1;
  const xMax = Math.max(...xs) + 1;
  const yMin = Math.min(...ys) - 1;
  const yMax = Math.max(...ys) + 1;

  return createFunctionSvg({
    xMin,
    xMax,
    yMin,
    yMax,
    curves: Object.assign([], { points: uniq })
  });
}

function transformAsciiTriangleCodeBlocks(container) {
  if (!container) return;
  const codeBlocks = Array.from(container.querySelectorAll("pre > code"));
  codeBlocks.forEach((codeEl) => {
    const raw = (codeEl.textContent || "").replace(/\r/g, "").trim();
    if (!raw) return;
    const pre = codeEl.parentElement;
    if (!pre) return;

    const rectangleType = detectRectangleType(raw, pre);
    if (rectangleType) {
      const graphic = createRectangleGraphic(rectangleType);
      pre.replaceWith(graphic);
      return;
    }

    const triangleType = detectTriangleType(raw, pre);
    if (!triangleType) return;

    const graphic = createTriangleGraphic(triangleType);
    pre.replaceWith(graphic);
  });
}

function detectTriangleType(ascii, pre) {
  const context = collectTriangleContext(pre);
  if (/right\s+triangle|прямоугольн(?:ый|ого|ом)?\s+треуголь/i.test(context)) return "right";
  if (/equilateral|равносторон/i.test(context)) return "equilateral";
  if (/isosceles|равнобедрен/i.test(context)) return "isosceles";
  if (/rectangle|прямоугольник|square|квадрат/i.test(context)) return null;

  const compact = ascii.replace(/[ \t\n]/g, "");
  if (compact.length < 4) return null;
  if (/[a-zа-яё0-9]/i.test(compact)) return null;
  if (!/[\/\\|_]/.test(compact)) return null;
  if (!/(\/\\|\\\/|\/_|_\||\|_|\\\\)/.test(compact)) return null;

  if (compact.includes("|") && compact.includes("_")) return "right";
  if (compact.includes("/\\") && compact.includes("_")) return "equilateral";
  return "isosceles";
}

function detectRectangleType(ascii, pre) {
  const context = collectTriangleContext(pre);
  if (/square|квадрат/i.test(context)) return "square";
  if (/rectangle|прямоугольник/i.test(context)) return "rectangle";

  const compact = ascii.replace(/[ \t\n]/g, "");
  if (compact.length < 4) return null;
  if (!/[|]/.test(compact)) return null;
  if (!/[-_]/.test(compact)) return null;
  if (/[\/\\]/.test(compact)) return null;
  return "rectangle";
}

function collectTriangleContext(pre) {
  const chunks = [];
  let cursor = pre.previousElementSibling;
  let steps = 0;
  while (cursor && steps < 4) {
    const text = (cursor.textContent || "").trim();
    if (text) chunks.push(text);
    cursor = cursor.previousElementSibling;
    steps += 1;
  }
  const parent = pre.parentElement;
  if (parent) {
    const heading = parent.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading && heading.textContent) {
      chunks.push(heading.textContent.trim());
    }
  }
  return chunks.join(" ").toLowerCase();
}

function createTriangleGraphic(type) {
  const width = 460;
  const height = 260;
  const svgNs = "http://www.w3.org/2000/svg";
  const wrapper = document.createElement("div");
  wrapper.className = "latex-graphic triangle-graphic";

  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "latex-graphic-svg");

  const bg = document.createElementNS(svgNs, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("rx", "12");
  bg.setAttribute("class", "latex-graphic-bg");
  svg.appendChild(bg);

  const points = getTrianglePoints(type);
  const polygon = document.createElementNS(svgNs, "polygon");
  polygon.setAttribute("points", `${points.A.x},${points.A.y} ${points.B.x},${points.B.y} ${points.C.x},${points.C.y}`);
  polygon.setAttribute("class", "triangle-shape");
  svg.appendChild(polygon);

  drawTriangleLabels(svg, points);

  if (type === "right") {
    const marker = document.createElementNS(svgNs, "path");
    const m = points.B;
    marker.setAttribute("d", `M ${m.x + 2} ${m.y - 22} L ${m.x + 2} ${m.y - 8} L ${m.x + 16} ${m.y - 8}`);
    marker.setAttribute("class", "triangle-right-mark");
    svg.appendChild(marker);
  }

  wrapper.appendChild(svg);
  return wrapper;
}

function getTrianglePoints(type) {
  if (type === "right") {
    return {
      A: { x: 145, y: 55 },
      B: { x: 145, y: 205 },
      C: { x: 345, y: 205 }
    };
  }
  if (type === "equilateral") {
    return {
      A: { x: 230, y: 48 },
      B: { x: 105, y: 210 },
      C: { x: 355, y: 210 }
    };
  }
  return {
    A: { x: 230, y: 58 },
    B: { x: 125, y: 210 },
    C: { x: 335, y: 210 }
  };
}

function createRectangleGraphic(type) {
  const width = 460;
  const height = 260;
  const svgNs = "http://www.w3.org/2000/svg";
  const wrapper = document.createElement("div");
  wrapper.className = "latex-graphic";

  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "latex-graphic-svg");

  const bg = document.createElementNS(svgNs, "rect");
  bg.setAttribute("x", "0");
  bg.setAttribute("y", "0");
  bg.setAttribute("width", String(width));
  bg.setAttribute("height", String(height));
  bg.setAttribute("rx", "12");
  bg.setAttribute("class", "latex-graphic-bg");
  svg.appendChild(bg);

  const points = type === "square"
    ? {
        A: { x: 130, y: 70 },
        B: { x: 130, y: 190 },
        C: { x: 250, y: 190 },
        D: { x: 250, y: 70 }
      }
    : {
        A: { x: 100, y: 75 },
        B: { x: 100, y: 190 },
        C: { x: 330, y: 190 },
        D: { x: 330, y: 75 }
      };

  const polygon = document.createElementNS(svgNs, "polygon");
  polygon.setAttribute("points", `${points.A.x},${points.A.y} ${points.B.x},${points.B.y} ${points.C.x},${points.C.y} ${points.D.x},${points.D.y}`);
  polygon.setAttribute("class", "triangle-shape");
  svg.appendChild(polygon);

  const rightMark = document.createElementNS(svgNs, "path");
  rightMark.setAttribute("d", `M ${points.B.x + 3} ${points.B.y - 22} L ${points.B.x + 3} ${points.B.y - 8} L ${points.B.x + 17} ${points.B.y - 8}`);
  rightMark.setAttribute("class", "triangle-right-mark");
  svg.appendChild(rightMark);

  drawPolygonLabels(svg, [
    { key: "A", point: points.A, dx: -8, dy: -10 },
    { key: "B", point: points.B, dx: -14, dy: 16 },
    { key: "C", point: points.C, dx: 10, dy: 16 },
    { key: "D", point: points.D, dx: 10, dy: -10 }
  ]);

  wrapper.appendChild(svg);
  return wrapper;
}

function drawTriangleLabels(svg, points) {
  drawPolygonLabels(svg, [
    { key: "A", dx: 0, dy: -12 },
    { key: "B", dx: -14, dy: 16 },
    { key: "C", dx: 10, dy: 16 }
  ].map((item) => ({ ...item, point: points[item.key] })));
}

function drawPolygonLabels(svg, labels) {
  const svgNs = "http://www.w3.org/2000/svg";
  labels.forEach(({ key, point, dx, dy }) => {
    const p = point;
    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("cx", String(p.x));
    dot.setAttribute("cy", String(p.y));
    dot.setAttribute("r", "3.3");
    dot.setAttribute("class", "latex-geom-point");
    svg.appendChild(dot);

    const text = document.createElementNS(svgNs, "text");
    text.setAttribute("x", String(p.x + dx));
    text.setAttribute("y", String(p.y + dy));
    text.setAttribute("class", "latex-geom-label");
    text.textContent = key;
    svg.appendChild(text);
  });
}

function normalizeLatexExpression(expr) {
  return String(expr || "")
    .replace(/\\cdot/g, "*")
    .replace(/\\pi/g, "pi")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\\ln/g, "ln")
    .replace(/\\log/g, "log")
    .replace(/\\exp/g, "exp")
    .replace(/\\sqrt\s*\{/g, "sqrt(")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\s+/g, "");
}

function safeEvaluateExpression(expr, xValue) {
  const tokens = tokenizeExpression(expr);
  if (tokens.length === 0) return NaN;
  const rpn = toRpn(tokens);
  return evalRpn(rpn, xValue);
}

function tokenizeExpression(expr) {
  const tokens = [];
  const src = String(expr || "");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[0-9.]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      tokens.push({ type: "number", value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[a-zA-Z]/.test(src[j])) j += 1;
      const word = src.slice(i, j).toLowerCase();
      if (word === "x") tokens.push({ type: "var" });
      else if (word === "pi") tokens.push({ type: "number", value: Math.PI });
      else tokens.push({ type: "func", value: word });
      i = j;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      if (ch === "(" || ch === ")" || ch === ",") {
        tokens.push({ type: "paren", value: ch });
      } else {
        tokens.push({ type: "op", value: ch });
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return insertImplicitMultiplication(fixUnaryMinus(tokens));
}

function fixUnaryMinus(tokens) {
  const result = [];
  tokens.forEach((token, index) => {
    if (token.type === "op" && token.value === "-") {
      const prev = tokens[index - 1];
      if (!prev || (prev.type === "op") || (prev.type === "paren" && prev.value === "(")) {
        result.push({ type: "number", value: 0 });
      }
    }
    result.push(token);
  });
  return result;
}

function insertImplicitMultiplication(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i];
    const prev = out[out.length - 1];
    if (prev && shouldInsertMultiply(prev, current)) {
      out.push({ type: "op", value: "*" });
    }
    out.push(current);
  }
  return out;
}

function shouldInsertMultiply(prev, current) {
  const prevIsValue =
    prev.type === "number" ||
    prev.type === "var" ||
    (prev.type === "paren" && prev.value === ")");
  const currentStartsValue =
    current.type === "number" ||
    current.type === "var" ||
    current.type === "func" ||
    (current.type === "paren" && current.value === "(");
  if (!prevIsValue || !currentStartsValue) return false;
  if (prev.type === "func") return false;
  return true;
}

function toRpn(tokens) {
  const output = [];
  const stack = [];
  const prec = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };
  const rightAssoc = { "^": true };
  tokens.forEach((token) => {
    if (token.type === "number" || token.type === "var") {
      output.push(token);
      return;
    }
    if (token.type === "func") {
      stack.push(token);
      return;
    }
    if (token.type === "op") {
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.type !== "op") break;
        const take = rightAssoc[token.value]
          ? prec[token.value] < prec[top.value]
          : prec[token.value] <= prec[top.value];
        if (!take) break;
        output.push(stack.pop());
      }
      stack.push(token);
      return;
    }
    if (token.type === "paren" && token.value === "(") {
      stack.push(token);
      return;
    }
    if (token.type === "paren" && token.value === ")") {
      while (stack.length > 0 && !(stack[stack.length - 1].type === "paren" && stack[stack.length - 1].value === "(")) {
        output.push(stack.pop());
      }
      if (stack.length > 0) stack.pop();
      if (stack.length > 0 && stack[stack.length - 1].type === "func") {
        output.push(stack.pop());
      }
    }
  });
  while (stack.length > 0) {
    output.push(stack.pop());
  }
  return output;
}

function evalRpn(tokens, xValue) {
  const stack = [];
  for (const token of tokens) {
    if (token.type === "number") {
      stack.push(token.value);
      continue;
    }
    if (token.type === "var") {
      stack.push(xValue);
      continue;
    }
    if (token.type === "op") {
      const b = stack.pop();
      const a = stack.pop();
      if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
      if (token.value === "+") stack.push(a + b);
      else if (token.value === "-") stack.push(a - b);
      else if (token.value === "*") stack.push(a * b);
      else if (token.value === "/") stack.push(Math.abs(b) < 1e-12 ? NaN : a / b);
      else if (token.value === "^") stack.push(Math.pow(a, b));
      continue;
    }
    if (token.type === "func") {
      const a = stack.pop();
      if (!Number.isFinite(a)) return NaN;
      if (token.value === "sin") stack.push(Math.sin(a));
      else if (token.value === "cos") stack.push(Math.cos(a));
      else if (token.value === "tan") stack.push(Math.tan(a));
      else if (token.value === "sqrt") stack.push(a < 0 ? NaN : Math.sqrt(a));
      else if (token.value === "exp") stack.push(Math.exp(a));
      else if (token.value === "ln" || token.value === "log") stack.push(a <= 0 ? NaN : Math.log(a));
      else if (token.value === "abs") stack.push(Math.abs(a));
      else return NaN;
    }
  }
  if (stack.length !== 1) return NaN;
  return stack[0];
}


export function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
