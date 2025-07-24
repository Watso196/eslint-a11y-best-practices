"use strict";

const ts = require("typescript");

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Suggest using <p> instead of <div>, <span>, or non-labeled <label> for inline/textual content",
      category: "Accessibility",
      recommended: false,
    },
    hasSuggestions: true,
    schema: [],
    messages: {
      preferP:
        "Consider using a <p> tag instead of <{{tag}}> for purely textual content.",
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();

    const INLINE_ELEMENTS = new Set([
      "a",
      "abbr",
      "b",
      "bdi",
      "bdo",
      "br",
      "cite",
      "code",
      "data",
      "dfn",
      "em",
      "i",
      "kbd",
      "mark",
      "q",
      "rp",
      "rt",
      "ruby",
      "s",
      "samp",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "time",
      "u",
      "var",
      "wbr",
    ]);

    const BLOCK_ELEMENTS = new Set([
      "article",
      "aside",
      "div",
      "footer",
      "header",
      "main",
      "nav",
      "section",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "ul",
      "ol",
      "li",
      "form",
      "details",
      "summary",
      "button",
    ]);

    const services = context.parserServices;
    const hasTypeInfo =
      services?.hasFullTypeInformation &&
      services?.esTreeNodeToTSNodeMap &&
      services?.program;

    const typeChecker = hasTypeInfo ? services.program.getTypeChecker() : null;

    function isProbablyTextType(type) {
      const flags = ts.TypeFlags;
      return (
        (type.flags & flags.StringLike) !== 0 ||
        (type.flags & flags.StringLiteral) !== 0 ||
        (type.flags & flags.TemplateLiteral) !== 0
      );
    }

    function checkNode(node) {
      if (reportedNodes.has(node)) return; // Prevent multiple reports

      let ancestor = node.parent;
      while (ancestor) {
        if (
          ancestor.type === "JSXElement" &&
          ancestor.openingElement.name.type === "JSXIdentifier"
        ) {
          const ancestorTag = ancestor.openingElement.name.name;

          // Check if ancestor meets the same conditions (inline children etc)
          const ancestorChildren = ancestor.children.filter(
            (child) => !(child.type === "JSXText" && child.value.trim() === "")
          );
          const ancestorAllInline = ancestorChildren.every(isInlineOrText);

          if (
            (ancestorTag === "div" || ancestorTag === "span") &&
            ancestorAllInline
          ) {
            return; // Skip reporting this node since ancestor will cover it
          }
        }
        ancestor = ancestor.parent;
      }

      reportedNodes.add(node);

      const tagNode = node.openingElement.name;
      if (tagNode.type !== "JSXIdentifier") return;

      const tagName = tagNode.name;
      const isLabel = tagName === "label";
      const isDivOrSpan = tagName === "div" || tagName === "span";

      if (!isDivOrSpan && !isLabel) return;

      const attributes = node.openingElement.attributes || [];

      if (attributes.some((attr) => attr.type === "JSXSpreadAttribute")) return;

      const hasHtmlFor = attributes.some(
        (attr) =>
          attr.type === "JSXAttribute" &&
          (attr.name?.name === "htmlFor" || attr.name?.name === "for")
      );

      if (isLabel && hasHtmlFor) return;

      const children = node.children.filter(
        (child) => !(child.type === "JSXText" && child.value.trim() === "")
      );

      if (children.length === 0) return;

      const allInline = children.every(isInlineOrText);
      if (!allInline) return;

      // 🆕 SKIP reporting span inside <p>
      // 🆕 SKIP reporting div inside <p>
      const parent = node.parent;
      if (
        (tagName === "span" || tagName === "div") &&
        parent?.type === "JSXElement" &&
        parent.openingElement?.name?.type === "JSXIdentifier" &&
        parent.openingElement.name.name === "p"
      ) {
        return; // skip <span> or <div> inside <p>
      }

      context.report({
        node: tagNode,
        messageId: "preferP",
        data: { tag: tagName },
        suggest: [
          {
            desc: "Replace element with <p>",
            fix(fixer) {
              const fixes = [];

              const openingName = node.openingElement.name;
              if (openingName && openingName.type === "JSXIdentifier") {
                fixes.push(fixer.replaceText(openingName, "p"));
              }

              const closingName = node.closingElement?.name;
              if (closingName && closingName.type === "JSXIdentifier") {
                fixes.push(fixer.replaceText(closingName, "p"));
              }

              return fixes;
            },
          },
        ],
      });
    }

    function traverseNode(node) {
      if (!node) return;

      if (node.type === "JSXElement") {
        checkNode(node);
        node.children.forEach(traverseNode);
      } else if (node.type === "JSXFragment") {
        node.children.forEach(traverseNode);
      } else if (node.type === "JSXExpressionContainer") {
        const expr = node.expression;
        if (!expr) return false;

        // Allow unknown expressions through instead of blocking the whole check
        if (!hasTypeInfo) return true;

        try {
          const type = typeChecker.getTypeAtLocation(expr);
          return isProbablyTextType(type);
        } catch {
          return true; // Again, fail open here
        }
      } else if (node.type === "ConditionalExpression") {
        traverseNode(node.consequent);
        traverseNode(node.alternate);
      } else if (node.type === "LogicalExpression") {
        traverseNode(node.left);
        traverseNode(node.right);
      } else if (node.type === "ArrayExpression") {
        node.elements.forEach(traverseNode);
      } else if (node.type === "CallExpression") {
        // Traverse arguments (e.g., array.map(() => <JSX />))
        node.arguments.forEach(traverseNode);

        // Also traverse the callee if it's a function returning JSX
        traverseNode(node.callee);
      } else if (node.type === "ReturnStatement") {
        traverseNode(node.argument);
      } else if (
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression"
      ) {
        traverseNode(node.body);
      } else if (node.type === "BlockStatement") {
        node.body.forEach(traverseNode);
      } else if (node.type === "ExpressionStatement") {
        traverseNode(node.expression);
      } else if (node.type === "ParenthesizedExpression") {
        traverseNode(node.expression);
      } else if (node.type === "VariableDeclarator") {
        traverseNode(node.init);
      } else if (node.type === "ObjectExpression") {
        node.properties.forEach((prop) => {
          if (prop.type === "Property") {
            traverseNode(prop.value);
          }
        });
      }
    }

    function isInlineOrText(node) {
      if (!node) return false;

      if (node.type === "Literal" && typeof node.value === "string") {
        return true;
      }

      if (node.type === "JSXText") {
        return node.value.trim() !== "";
      }

      if (node.type === "JSXExpressionContainer") {
        const expr = node.expression;
        if (!expr) return false;

        if (!hasTypeInfo) {
          return true; // Fail open if no type info is available
        }

        try {
          const checker = services.program.getTypeChecker();
          const tsNode = services.esTreeNodeToTSNodeMap.get(expr);
          const type = checker.getTypeAtLocation(tsNode);
          if (!type) return false;

          const flags = ts.TypeFlags;
          return (
            (type.flags & flags.StringLike) !== 0 ||
            (type.flags & flags.StringLiteral) !== 0 ||
            (type.flags & flags.TemplateLiteral) !== 0
          );
        } catch {
          return true;
        }
      }

      if (node.type === "JSXElement") {
        const tagNameNode = node.openingElement.name;
        if (tagNameNode.type !== "JSXIdentifier") return false;

        const tag = tagNameNode.name;
        if (tag[0] === tag[0].toUpperCase()) return false; // custom component
        if (BLOCK_ELEMENTS.has(tag)) return false;
        if (!INLINE_ELEMENTS.has(tag)) return false;

        const children = node.children.filter(
          (child) => !(child.type === "JSXText" && child.value.trim() === "")
        );

        return children.every(isInlineOrText);
      }

      return false;
    }

    const reportedNodes = new WeakSet();

    return {
      JSXElement(node) {
        traverseNode(node);
      },
      JSXFragment(node) {
        traverseNode(node);
      },
    };
  },
};
