/* exported addConfluenceTurndownRules */

/**
 * Adds Confluence-specific Turndown rules for proper Markdown conversion.
 * Handles: panels, expand macros, status badges, code macros with language.
 * @param {TurndownService} turndown
 */
function addConfluenceTurndownRules(turndown) {

  // --- Info / Warning / Note / Tip panels → blockquote with label ---
  // HTML: <div class="confluence-information-macro confluence-information-macro-{type}">
  //         <div class="confluence-information-macro-body"><p>Content</p></div>
  //       </div>
  const PANEL_TYPE_MAP = {
    'information': 'INFO',
    'warning':     'WARNING',
    'note':        'NOTE',
    'tip':         'TIP',
  };

  turndown.addRule('confluencePanel', {
    filter(node) {
      return (
        node.nodeName === 'DIV' &&
        node.classList.contains('confluence-information-macro')
      );
    },
    replacement(content, node) {
      let type = 'NOTE';
      for (const [key, label] of Object.entries(PANEL_TYPE_MAP)) {
        if (node.classList.contains(`confluence-information-macro-${key}`)) {
          type = label;
          break;
        }
      }
      // Extract only the body content (skip the icon span)
      const bodyEl = node.querySelector('.confluence-information-macro-body');
      const bodyContent = bodyEl ? turndown.turndown(bodyEl.innerHTML) : content;
      const lines = bodyContent.trim().split('\n');
      const quoted = lines.map(l => `> ${l}`).join('\n');
      return `\n> **${type}**\n${quoted}\n`;
    },
  });

  // --- Expand macros → <details><summary> ---
  // HTML: <div class="expand-container">
  //         <div class="expand-control"><span class="expand-control-text">Title</span></div>
  //         <div class="expand-content"><p>Content</p></div>
  //       </div>
  turndown.addRule('confluenceExpand', {
    filter(node) {
      return (
        node.nodeName === 'DIV' &&
        node.classList.contains('expand-container')
      );
    },
    replacement(_content, node) {
      const titleEl = node.querySelector('.expand-control-text');
      const contentEl = node.querySelector('.expand-content');
      const title = titleEl ? titleEl.textContent.trim() : 'Details';
      const body = contentEl ? turndown.turndown(contentEl.innerHTML).trim() : '';
      return `\n<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>\n`;
    },
  });

  // --- Status badges → [STATUS: text] ---
  // HTML: <span class="status-macro aui-lozenge aui-lozenge-success">DONE</span>
  turndown.addRule('confluenceStatus', {
    filter(node) {
      return (
        node.nodeName === 'SPAN' &&
        node.classList.contains('status-macro')
      );
    },
    replacement(_content, node) {
      const text = node.textContent.trim();
      return `**[${text}]**`;
    },
  });

  // --- Code macros with language → fenced code blocks ---
  // HTML: <div class="code panel ...">
  //         <div class="codeContent panelContent ...">
  //           <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; ...">
  //             code here
  //           </pre>
  //         </div>
  //       </div>
  turndown.addRule('confluenceCodeBlock', {
    filter(node) {
      if (node.nodeName !== 'DIV') return false;
      return node.classList.contains('code') && node.classList.contains('panel');
    },
    replacement(_content, node) {
      const pre = node.querySelector('pre.syntaxhighlighter-pre, pre[class*="syntaxhighlighter"]');
      if (!pre) {
        // Fallback: just get any pre content
        const anyPre = node.querySelector('pre');
        const code = anyPre ? anyPre.textContent : '';
        return `\n\`\`\`\n${code}\n\`\`\`\n`;
      }

      // Extract language from data-syntaxhighlighter-params="brush: java; ..."
      let lang = '';
      const params = pre.getAttribute('data-syntaxhighlighter-params') || '';
      const brushMatch = params.match(/brush:\s*([^;]+)/);
      if (brushMatch) {
        lang = brushMatch[1].trim();
        // Map Confluence brush names to standard language identifiers
        const BRUSH_MAP = {
          'jscript':    'javascript',
          'js':         'javascript',
          'py':         'python',
          'bash':       'bash',
          'sh':         'bash',
          'csharp':     'csharp',
          'cpp':        'cpp',
          'plain':      '',
          'text':       '',
          'none':       '',
        };
        lang = BRUSH_MAP[lang] ?? lang;
      }

      const code = pre.textContent;
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    },
  });

  // --- Confluence table of contents macro → remove ---
  // HTML: <div class="toc-macro ...">...</div>
  turndown.addRule('confluenceToc', {
    filter(node) {
      return node.nodeName === 'DIV' && node.classList.contains('toc-macro');
    },
    replacement() { return ''; },
  });

  // --- Confluence page-layout sections → just render content ---
  // HTML: <div class="columnLayout ..."><div class="cell ...">content</div></div>
  turndown.addRule('confluenceLayout', {
    filter(node) {
      return (
        node.nodeName === 'DIV' &&
        (node.classList.contains('columnLayout') || node.classList.contains('cell'))
      );
    },
    replacement(content) {
      return content;
    },
  });

  // --- User mentions → @name ---
  // HTML: <a class="confluence-userlink" data-username="jdoe">John Doe</a>
  turndown.addRule('confluenceUserMention', {
    filter(node) {
      return (
        node.nodeName === 'A' &&
        node.classList.contains('confluence-userlink')
      );
    },
    replacement(_content, node) {
      const name = node.textContent.trim();
      return `@${name}`;
    },
  });

  // --- Jira issue links → [KEY-123](url) ---
  // HTML: <a class="jira-issue-macro-key" href="...">KEY-123</a>
  turndown.addRule('confluenceJiraLink', {
    filter(node) {
      return (
        node.nodeName === 'A' &&
        (node.classList.contains('jira-issue-macro-key') ||
         node.classList.contains('jira-issue'))
      );
    },
    replacement(_content, node) {
      const key = node.textContent.trim();
      const href = node.getAttribute('href');
      if (href) return `[${key}](${href})`;
      return key;
    },
  });
}
