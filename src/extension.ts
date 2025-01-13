import * as vscode from 'vscode';

let boldDecorationType: vscode.TextEditorDecorationType;
let thinDecorationType: vscode.TextEditorDecorationType;

// Optimized regex pattern for word matching
const WORD_REGEX = /\b\w+\b/g;
const BATCH_SIZE = 10000; // Increased batch size for better performance

// Cache for decorations to avoid unnecessary updates
const decorationCache = new Map<string, {
    bold: vscode.DecorationOptions[],
    thin: vscode.DecorationOptions[]
}>();

// Configuration cache
let configCache = {
    prefix: '',
    suffix: '',
    fixationLevel: 1,
    extraContrast: true,
    debounceDelay: 150,
    enabled: true,
    currentLineOnly: false,
    lastVersion: 0 // Track content version
};

// Copied from TextVide
const FIXATION_POINTS = [
    [0, 4, 12, 17, 24, 29, 35, 42, 48], // Level 1
    [1, 2, 7, 10, 13, 14, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49], // Level 2
    [1, 2, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49], // Level 3
    [0, 2, 4, 5, 6, 8, 9, 11, 14, 15, 17, 18, 20, 0, 21, 23, 24, 26, 27, 29, 30, 32, 33, 35, 36, 38, 39, 41, 42, 44, 45, 47, 48], // Level 4
    [0, 2, 3, 5, 6, 7, 8, 10, 11, 12, 14, 15, 17, 19, 20, 21, 23, 24, 25, 26, 28, 29, 30, 32, 33, 34, 35, 37, 38, 39, 41, 42, 43, 44, 46, 47, 48] // Level 5
];

// Add this at the top with other caches
const fixationCache = new Map<string, number>();

function updateConfigCache() {
    const config = vscode.workspace.getConfiguration('codeVide');
    const sep = config.get<string | string[]>('sep');
    
    if (Array.isArray(sep) && sep.length >= 2) {
        configCache.prefix = sep[0] ?? '';
        configCache.suffix = sep[1] ?? '';
    } else {
        const separator = typeof sep === 'string' ? sep : '';
        configCache.prefix = configCache.suffix = separator;
    }
    
    configCache.fixationLevel = config.get<number>('fixationPoint') ?? 1;
    configCache.extraContrast = config.get<boolean>('extraContrast') ?? false;
    configCache.debounceDelay = config.get<number>('debounceDelay') ?? 150;
    configCache.enabled = config.get<boolean>('enabled') ?? true;
    configCache.currentLineOnly = config.get<boolean>('currentLineOnly') ?? false;
    fixationCache.clear();
}

function getBoldDecorationConfig() {
    return {
        fontWeight: '900',
        before: configCache.prefix ? { contentText: configCache.prefix } : undefined,
        after: configCache.suffix ? { contentText: configCache.suffix } : undefined
    };
}

function getThinDecorationConfig() {
    return configCache.extraContrast ? { fontWeight: '100' } : {};
}

function getFixationPoint(wordLength: number): number {
    // Create cache key combining level and word length
    const cacheKey = `${configCache.fixationLevel}_${wordLength}`;
    
    // Check cache first
    const cached = fixationCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const level = Math.max(1, Math.min(5, configCache.fixationLevel));
    const fixationArray = FIXATION_POINTS[level - 1] ?? FIXATION_POINTS[0];
    
    const index = fixationArray.findIndex(point => wordLength <= point);
    const result = index === -1 
        ? Math.max(wordLength - fixationArray.length, 0)
        : Math.max(wordLength - index, 0);

    // Cache the result
    fixationCache.set(cacheKey, result);
    return result;
}

// Optimized debounce with type safety
function debounce<T extends (...args: any[]) => void>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout;
    return (...args: Parameters<T>) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

function processTextChunk(
    editor: vscode.TextEditor,
    startOffset: number,
    endOffset: number,
    boldDecorations: vscode.DecorationOptions[],
    thinDecorations: vscode.DecorationOptions[]
) {
    const text = editor.document.getText(new vscode.Range(
        editor.document.positionAt(startOffset),
        editor.document.positionAt(endOffset)
    ));

    // Pre-calculate document positions for the chunk
    const startPos = editor.document.positionAt(startOffset);
    const lineOffset = startPos.line;

    WORD_REGEX.lastIndex = 0;
    let match;

    while ((match = WORD_REGEX.exec(text)) !== null) {
        const wordStart = startOffset + match.index;
        const wordLength = match[0].length;
        const splitPoint = getFixationPoint(wordLength);

        if (splitPoint > 0) {
            // Calculate positions more efficiently using line offset
            const wordStartPos = editor.document.positionAt(wordStart);
            const splitPos = editor.document.positionAt(wordStart + splitPoint);
            
            boldDecorations.push({ range: new vscode.Range(wordStartPos, splitPos) });
            
            if (splitPoint < wordLength) {
                const wordEndPos = editor.document.positionAt(wordStart + wordLength);
                thinDecorations.push({ range: new vscode.Range(splitPos, wordEndPos) });
            }
        }
    }
}

function updateDecorations(editor: vscode.TextEditor | undefined) {
    if (!editor || !configCache.enabled) {
        if (editor) {
            editor.setDecorations(boldDecorationType, []);
            editor.setDecorations(thinDecorationType, []);
        }
        return;
    }

    const document = editor.document;
    
    // If currentLineOnly is enabled, only process the current line
    if (configCache.currentLineOnly) {
        const currentLine = editor.selection.active.line;
        const lineText = document.lineAt(currentLine);
        const boldDecorations: vscode.DecorationOptions[] = [];
        const thinDecorations: vscode.DecorationOptions[] = [];
        
        processTextChunk(
            editor,
            document.offsetAt(lineText.range.start),
            document.offsetAt(lineText.range.end),
            boldDecorations,
            thinDecorations
        );

        editor.setDecorations(boldDecorationType, boldDecorations);
        editor.setDecorations(thinDecorationType, thinDecorations);
        return;
    }

    const documentKey = `${document.uri.toString()}_${document.version}`;

    // Simple cache check
    const cached = decorationCache.get(documentKey);
    if (cached) {
        editor.setDecorations(boldDecorationType, cached.bold);
        editor.setDecorations(thinDecorationType, cached.thin);
        return;
    }

    // Clear old caches when adding new ones
    if (decorationCache.size > 10) {
        decorationCache.clear();
    }

    // Process the entire document
    const boldDecorations: vscode.DecorationOptions[] = [];
    const thinDecorations: vscode.DecorationOptions[] = [];
    
    const documentLength = document.getText().length;
    for (let offset = 0; offset < documentLength; offset += BATCH_SIZE) {
        processTextChunk(
            editor,
            offset,
            Math.min(offset + BATCH_SIZE, documentLength),
            boldDecorations,
            thinDecorations
        );
    }

    // Cache the results
    decorationCache.set(documentKey, {
        bold: boldDecorations,
        thin: thinDecorations
    });

    editor.setDecorations(boldDecorationType, boldDecorations);
    editor.setDecorations(thinDecorationType, thinDecorations);
}

export function activate(context: vscode.ExtensionContext) {
    updateConfigCache();
    
    boldDecorationType = vscode.window.createTextEditorDecorationType(getBoldDecorationConfig());
    thinDecorationType = vscode.window.createTextEditorDecorationType(getThinDecorationConfig());

    const debouncedUpdateDecorations = debounce((editor: vscode.TextEditor) => {
        updateDecorations(editor);
    }, configCache.debounceDelay);

    // Register event handlers
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('codeVide')) {
                updateConfigCache();
                decorationCache.clear();
                boldDecorationType.dispose();
                thinDecorationType.dispose();
                
                boldDecorationType = vscode.window.createTextEditorDecorationType(getBoldDecorationConfig());
                thinDecorationType = vscode.window.createTextEditorDecorationType(getThinDecorationConfig());
                
                if (vscode.window.activeTextEditor) {
                    debouncedUpdateDecorations(vscode.window.activeTextEditor);
                }
            }
        }),

        vscode.commands.registerCommand('code-vide.toggle', async () => {
            const config = vscode.workspace.getConfiguration('codeVide');
            const currentEnabled = config.get<boolean>('enabled') ?? true;
            await config.update('enabled', !currentEnabled, true);
        }),
        
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                debouncedUpdateDecorations(editor);
            }
        }),

        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                debouncedUpdateDecorations(editor);
            }
        }),

        vscode.window.onDidChangeTextEditorSelection(event => {
            if (configCache.currentLineOnly && event.textEditor) {
                debouncedUpdateDecorations(event.textEditor);
            }
        })
    );

    if (vscode.window.activeTextEditor) {
        debouncedUpdateDecorations(vscode.window.activeTextEditor);
    }
}

export function deactivate() {
    decorationCache.clear();
    boldDecorationType?.dispose();
    thinDecorationType?.dispose();
} 