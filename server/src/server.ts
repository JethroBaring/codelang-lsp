import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  DocumentDiagnosticReportKind,
  type DocumentDiagnosticReport,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we fall back using global settings.
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      // Tell the client that this server supports code completion.
      completionProvider: {
        resolveProvider: true,
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
  };
  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }
  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((_event) => {
      connection.console.log('Workspace folder change event received.');
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }
  // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
  // We could optimize things here and re-fetch the setting first can compare it
  // to the existing setting, but this is out of scope for this example.
  connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: 'languageServerExample',
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

// Function to extract function declarations from the document
function extractFunctionDeclarations(
  document: TextDocument
): { name: string; params: string[] }[] {
  const functionDeclarations: { name: string; params: string[] }[] = [];
  const lines = document.getText().split('\n');
  let functionName = '';
  let functionParams: string[] = [];
  let isInFunction = false;

  lines.forEach((line) => {
    // Check if we're inside a function
    if (isInFunction) {
      // Check for the end of function
      if (line.trim() === 'END FN') {
        // Save function declaration
        functionDeclarations.push({
          name: functionName,
          params: functionParams,
        });
        functionName = '';
        functionParams = [];
        isInFunction = false;
      } else {
        // Extract parameters
        const matches = line.match(
          /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(STRING|INT|FLOAT|CHAR|BOOL)/g
        );
        if (matches) {
          matches.forEach((match) => {
            const parts = match.split(':');
            if (parts.length === 2) {
              const paramName = parts[0].trim();
              const paramType = parts[1].trim();
              functionParams.push(`${paramType} ${paramName}`);
            }
          });
        }
      }
    } else {
      // Check for the start of function
      const functionStartMatch = line.match(
        /\bFN\s+(?:STRING|INT|FLOAT|CHAR|BOOL)?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)/i
      );

      // 	const functionStartMatch = line.match(
      // 		/\bFN\s+(?:(STRING|INT|FLOAT|CHAR|BOOL)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(\s*((?:[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(STRING|INT|FLOAT|CHAR|BOOL)\s*(?:,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:\s*(STRING|INT|FLOAT|CHAR|BOOL)\s*)*)?)\s*\))/
      // );

      if (functionStartMatch) {
        functionName = functionStartMatch[1];
        const paramsString = functionStartMatch[2];
        functionParams = paramsString.split(',').map((param) => param.trim());
        isInFunction = true;
      }
    }
  });

  return functionDeclarations;
}

function extractVariableDeclarations(
  document: TextDocument
): { name: string; containerName: string }[] {
  const variableDeclarations: { name: string; containerName: string }[] = [];
  const lines = document.getText().split('\n');
  const paramRegex =
    /(?<!\bFN\s+)(STRING|INT|FLOAT|CHAR)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  lines.forEach((line) => {
    let matches;
    while ((matches = paramRegex.exec(line)) !== null) {
      const type = matches[1];
      const name = matches[2];
      variableDeclarations.push({ name, containerName: type });
    }
  });
  return variableDeclarations;
}

connection.languages.diagnostics.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (document !== undefined) {
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: await validateTextDocument(document),
    } satisfies DocumentDiagnosticReport;
  } else {
    // We don't know the document. We can either try to read it from disk
    // or we don't report problems for it.
    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: [],
    } satisfies DocumentDiagnosticReport;
  }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
  validateTextDocument(change.document);
});

async function validateTextDocument(
  textDocument: TextDocument
): Promise<Diagnostic[]> {
  // In this simple example we get the settings for every validate run.
  const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const text = textDocument.getText();
  const pattern = /\b[A-Z]{2,}\b/g;
  let m: RegExpExecArray | null;

  let problems = 0;
  const diagnostics: Diagnostic[] = [];
  while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
    problems++;
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: textDocument.positionAt(m.index),
        end: textDocument.positionAt(m.index + m[0].length),
      },
      message: `${m[0]} is all uppercase.`,
      source: 'ex',
    };
    if (hasDiagnosticRelatedInformationCapability) {
      diagnostic.relatedInformation = [
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Spelling matters',
        },
        {
          location: {
            uri: textDocument.uri,
            range: Object.assign({}, diagnostic.range),
          },
          message: 'Particularly for names',
        },
      ];
    }
  }
  return diagnostics;
}

connection.onDidChangeWatchedFiles((_change) => {
  // Monitored files have change in VSCode
  connection.console.log('We received a file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
      return [];
    }

    // Extract variable declarations from the document
    const variableDeclarations = extractVariableDeclarations(document);
    const functionDeclarations = extractFunctionDeclarations(document);
    // Create an array to hold completion items
    const completionItems: CompletionItem[] = [
      {
        label: 'BEGIN',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'END',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'IF',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'ELSE',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'WHILE',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'FN',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'STRING',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'CHAR',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'INT',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'FLOAT',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'BOOL',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: '"TRUE"',
        kind: CompletionItemKind.Keyword,
      },{
        label: '"FALSE"',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'RETURN',
        kind: CompletionItemKind.Keyword,
      },
      {
        label: 'scanString',
        kind: CompletionItemKind.Function,
      },
    ];

    // Add variable names to completion items
    variableDeclarations.forEach((variable) => {
      completionItems.push({
        label: variable.name,
        kind: CompletionItemKind.Variable,
        detail: variable.containerName,
      });
    });

    functionDeclarations.forEach((variable) => {
      completionItems.push({
        label: variable.name,
        kind: CompletionItemKind.Function,
      });
    });

    // Return completion items
    return completionItems;
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (item.data === 1) {
    item.detail = 'TypeScript details';
    item.documentation = 'TypeScript documentation';
  } else if (item.data === 2) {
    item.detail = 'JavaScript details';
    item.documentation = 'JavaScript documentation';
  }
  return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
