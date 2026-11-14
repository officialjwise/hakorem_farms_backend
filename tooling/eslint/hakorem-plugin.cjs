'use strict';
/**
 * Local ESLint rules for the HaKorem backend.
 *
 * no-number-arithmetic-with-money (ADR-0001): in a file that imports `Money`, arithmetic on JavaScript numbers is
 * an error. Money, quantity and weight arithmetic goes through the kernel's bigint types.
 *
 * no-import-outside-backend (ADR-0008 rule 5): a relative import may not resolve outside the repository, which is
 * how code from the frontend repository would get in.
 */
const path = require('node:path');
const ts = require('typescript');

const ARITHMETIC = new Set(['-', '*', '/', '%', '**', '+']);
const ARITHMETIC_ASSIGNMENT = new Set(['+=', '-=', '*=', '/=', '%=', '**=']);

function importsMoney(program) {
  return program.body.some(
    (node) =>
      node.type === 'ImportDeclaration' &&
      node.specifiers.some((s) => s.type === 'ImportSpecifier' && s.imported.type === 'Identifier' && s.imported.name === 'Money'),
  );
}

const noNumberArithmeticWithMoney = {
  meta: {
    type: 'problem',
    docs: { description: 'No arithmetic on JavaScript numbers in a file that imports Money (ADR-0001)' },
    messages: {
      number: 'Arithmetic on a JavaScript number in a file that imports Money. Use the kernel Money, Quantity or Weight types (ADR-0001).',
    },
    schema: [],
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services || !services.program) {
      return {};
    }
    const checker = services.program.getTypeChecker();
    const isNumber = (node) => {
      const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
      return (type.getFlags() & ts.TypeFlags.NumberLike) !== 0;
    };
    let active = false;
    return {
      Program(node) {
        active = importsMoney(node);
      },
      BinaryExpression(node) {
        if (active && ARITHMETIC.has(node.operator) && isNumber(node.left) && isNumber(node.right)) {
          context.report({ node, messageId: 'number' });
        }
      },
      AssignmentExpression(node) {
        if (active && ARITHMETIC_ASSIGNMENT.has(node.operator) && isNumber(node.left)) {
          context.report({ node, messageId: 'number' });
        }
      },
      UpdateExpression(node) {
        if (active && isNumber(node.argument)) {
          context.report({ node, messageId: 'number' });
        }
      },
    };
  },
};

const noImportOutsideBackend = {
  meta: {
    type: 'problem',
    docs: { description: 'No import that resolves outside the backend repository (ADR-0008)' },
    messages: { outside: 'This import resolves outside the backend repository: {{source}}' },
    schema: [{ type: 'object', properties: { root: { type: 'string' } }, additionalProperties: false }],
  },
  create(context) {
    const root = path.resolve(context.options[0]?.root ?? context.cwd);
    const check = (node, source) => {
      if (typeof source !== 'string') {
        return;
      }
      const outsideByPath = (source.startsWith('.') || path.isAbsolute(source)) &&
        path.relative(root, path.resolve(path.dirname(context.filename), source)).startsWith('..');
      if (outsideByPath || /(^|\/)frontend(\/|$)/.test(source)) {
        context.report({ node, messageId: 'outside', data: { source } });
      }
    };
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value),
    };
  },
};

module.exports = {
  meta: { name: 'hakorem' },
  rules: {
    'no-number-arithmetic-with-money': noNumberArithmeticWithMoney,
    'no-import-outside-backend': noImportOutsideBackend,
  },
};
