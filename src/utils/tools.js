/**
 * Tools Management Utility
 *
 * Manages tool definitions and categories
 */

import { lazy } from 'react';
import { BarChart2, Hash, Code, FileText, Palette, FileJson, Table, Calculator, Type, Eye, Link, Clock, Globe, CheckSquare, Network, Radio, Binary, KeyRound, Shuffle, Sigma, Blend, Puzzle, Shield } from 'lucide-react';

// Tool components are lazy-loaded (same React.lazy pattern as the top-level
// pages in App.jsx/JQLBuilder.jsx) so each tool's bundle - and its heavy
// dependencies (quicktype-core, prettier, pkijs, ...) - is only parsed
// when that specific tool is opened, not when the Tools page itself loads.
// ToolsPage renders these inside a <Suspense> boundary.
const Base64Tool = lazy(() => import('../components/features/tools/Base64Tool'));
const MorseCodeTool = lazy(() => import('../components/features/tools/MorseCodeTool'));
const CaesarCipherTool = lazy(() => import('../components/features/tools/CaesarCipherTool'));
const AffineCipherTool = lazy(() => import('../components/features/tools/AffineCipherTool'));
const XorCipherTool = lazy(() => import('../components/features/tools/XorCipherTool'));
const BinaryToStringTool = lazy(() => import('../components/features/tools/BinaryToStringTool'));
const SubstitutionCipherTool = lazy(() => import('../components/features/tools/SubstitutionCipherTool'));
const ColorConverterTool = lazy(() => import('../components/features/tools/ColorConverterTool'));
const CsvToJsonTool = lazy(() => import('../components/features/tools/CsvToJsonTool'));
const JsonToCsvTool = lazy(() => import('../components/features/tools/JsonToCsvTool'));
const NumberBaseConverterTool = lazy(() => import('../components/features/tools/NumberBaseConverterTool'));
const JsonFormatterTool = lazy(() => import('../components/features/tools/JsonFormatterTool'));
const UuidGeneratorTool = lazy(() => import('../components/features/tools/UuidGeneratorTool'));
const HashCalculatorTool = lazy(() => import('../components/features/tools/HashCalculatorTool'));
const SlaCalculatorTool = lazy(() => import('../components/features/tools/SlaCalculatorTool'));
const StringUtilitiesTool = lazy(() => import('../components/features/tools/StringUtilitiesTool'));
const MarkdownPreviewTool = lazy(() => import('../components/features/tools/MarkdownPreviewTool'));
const UrlEncoderTool = lazy(() => import('../components/features/tools/UrlEncoderTool'));
const RegexValidatorTool = lazy(() => import('../components/features/tools/RegexValidatorTool'));
const HtmlToMarkdownTool = lazy(() => import('../components/features/tools/HtmlToMarkdownTool'));
const JsonToYamlTool = lazy(() => import('../components/features/tools/JsonToYamlTool'));
const YamlToJsonTool = lazy(() => import('../components/features/tools/YamlToJsonTool'));
const XmlToJsonTool = lazy(() => import('../components/features/tools/XmlToJsonTool'));
const TimeFormatConverterTool = lazy(() => import('../components/features/tools/TimeFormatConverterTool'));
const TimeZoneConverterTool = lazy(() => import('../components/features/tools/TimeZoneConverterTool'));
const BackslashEscapeTool = lazy(() => import('../components/features/tools/BackslashEscapeTool'));
const HtmlEntitiesTool = lazy(() => import('../components/features/tools/HtmlEntitiesTool'));
const JwtDecoderTool = lazy(() => import('../components/features/tools/JwtDecoderTool'));
const CssFormatterTool = lazy(() => import('../components/features/tools/CssFormatterTool'));
const HtmlFormatterTool = lazy(() => import('../components/features/tools/HtmlFormatterTool'));
const SqlFormatterTool = lazy(() => import('../components/features/tools/SqlFormatterTool'));
const BarcodeTool = lazy(() => import('../components/features/tools/BarcodeTool'));
const QrCodeTool = lazy(() => import('../components/features/tools/QrCodeTool'));
const LoremIpsumTool = lazy(() => import('../components/features/tools/LoremIpsumTool'));
const JsonToInterfaceTool = lazy(() => import('../components/features/tools/JsonToInterfaceTool'));
const CsrGeneratorTool = lazy(() => import('../components/features/tools/CsrGeneratorTool'));
const CountdownTimerTool = lazy(() => import('../components/features/tools/CountdownTimerTool'));
const StopwatchTool = lazy(() => import('../components/features/tools/StopwatchTool'));
const StringAnalyzerTool = lazy(() => import('../components/features/tools/StringAnalyzerTool'));
const HistogramTool = lazy(() => import('../components/features/tools/HistogramTool'));
const SentenceBuilderTool = lazy(() => import('../components/features/tools/SentenceBuilderTool'));
const TextDiffTool = lazy(() => import('../components/features/tools/TextDiffTool'));
const UrlExploderTool = lazy(() => import('../components/features/tools/UrlExploderTool'));
const WhoisLookupTool = lazy(() => import('../components/features/tools/WhoisLookupTool'));
const IbanValidatorTool = lazy(() => import('../components/features/tools/IbanValidatorTool'));
const Ipv4SubnetCalculatorTool = lazy(() => import('../components/features/tools/Ipv4SubnetCalculatorTool'));
const Ipv6SubnetCalculatorTool = lazy(() => import('../components/features/tools/Ipv6SubnetCalculatorTool'));
const CronExpressionParserTool = lazy(() => import('../components/features/tools/CronExpressionParserTool'));
const OpenShiftTemplateTool = lazy(() => import('../components/features/tools/OpenShiftTemplateTool'));
const GtfobinsTool = lazy(() => import('../components/features/tools/gtfobins/GtfobinsTool'));

// Tool definitions
const TOOLS = [
  // ===== CALCULATE CATEGORY =====
  {
    id: 'hash-calculator',
    name: 'Hash Calculator',
    description: 'Calculate MD5, SHA1, SHA256, SHA384, SHA512 hashes',
    category: 'Calculate',
    icon: Hash,
    component: HashCalculatorTool
  },
  {
    id: 'sla-calculator',
    name: 'SLA Calculator',
    description: 'Calculate allowed downtime from SLA percentage',
    category: 'Calculate',
    icon: Calculator,
    component: SlaCalculatorTool
  },

  // ===== CONVERSION CATEGORY =====
  {
    id: 'color-converter',
    name: 'Color Converter',
    description: 'Convert between HEX, RGB, HSV, CMYK, LAB, LCH',
    category: 'Conversion',
    icon: Palette,
    component: ColorConverterTool
  },
  {
    id: 'csv-to-json',
    name: 'CSV to JSON',
    description: 'Convert CSV data to JSON format',
    category: 'Conversion',
    icon: FileJson,
    component: CsvToJsonTool
  },
  {
    id: 'html-to-markdown',
    name: 'HTML to Markdown',
    description: 'Convert HTML to Markdown format',
    category: 'Conversion',
    icon: Code,
    component: HtmlToMarkdownTool
  },
  {
    id: 'json-to-csv',
    name: 'JSON to CSV',
    description: 'Convert JSON array to CSV format',
    category: 'Conversion',
    icon: Table,
    component: JsonToCsvTool
  },
  {
    id: 'json-to-yaml',
    name: 'JSON to YAML',
    description: 'Convert JSON to YAML format',
    category: 'Conversion',
    icon: FileJson,
    component: JsonToYamlTool
  },
  {
    id: 'number-base-converter',
    name: 'Number Base Converter',
    description: 'Convert between Binary, Octal, Decimal, Hexadecimal',
    category: 'Conversion',
    icon: Hash,
    component: NumberBaseConverterTool
  },
  {
    id: 'string-utilities',
    name: 'String Utilities',
    description: 'Convert string cases and perform replacements',
    category: 'Conversion',
    icon: Type,
    component: StringUtilitiesTool
  },
  {
    id: 'time-format-converter',
    name: 'Time Format Converter',
    description: 'Convert between different time formats',
    category: 'Conversion',
    icon: Clock,
    component: TimeFormatConverterTool
  },
  {
    id: 'timezone-converter',
    name: 'Time Zone Converter',
    description: 'Convert times between different time zones',
    category: 'Conversion',
    icon: Globe,
    component: TimeZoneConverterTool
  },
  {
    id: 'xml-to-json',
    name: 'XML to JSON',
    description: 'Convert XML to JSON format',
    category: 'Conversion',
    icon: FileJson,
    component: XmlToJsonTool
  },
  {
    id: 'yaml-to-json',
    name: 'YAML to JSON',
    description: 'Convert YAML to JSON format',
    category: 'Conversion',
    icon: FileJson,
    component: YamlToJsonTool
  },

  // ===== ENCODE/DECODE CATEGORY =====
  {
    id: 'affine-cipher',
    name: 'Affine Cipher',
    description: 'Encode or decode text with an Affine cipher key (a, b)',
    category: 'Encode/Decode',
    icon: Sigma,
    component: AffineCipherTool
  },
  {
    id: 'base64-encoder',
    name: 'Base64',
    description: 'Encode and decode Base64 strings',
    category: 'Encode/Decode',
    icon: Code,
    component: Base64Tool
  },
  {
    id: 'backslash-escape',
    name: 'Backslash Escape/Unescape',
    description: 'Escape or unescape backslash characters',
    category: 'Encode/Decode',
    icon: Code,
    component: BackslashEscapeTool
  },
  {
    id: 'binary-to-string',
    name: 'Binary to String',
    description: 'Convert binary octets to text or text to binary, with UTF-8 multi-byte support',
    category: 'Encode/Decode',
    icon: Binary,
    component: BinaryToStringTool
  },
  {
    id: 'caesar-cipher',
    name: 'Caesar Cipher',
    description: 'Encode or decode text with a Caesar cipher shift',
    category: 'Encode/Decode',
    icon: Shuffle,
    component: CaesarCipherTool
  },
  {
    id: 'html-entities',
    name: 'HTML Entities',
    description: 'Encode/decode HTML entities',
    category: 'Encode/Decode',
    icon: Code,
    component: HtmlEntitiesTool
  },
  {
    id: 'jwt-decoder',
    name: 'JSON Web Token Decoder',
    description: 'Decode and inspect JWT tokens',
    category: 'Encode/Decode',
    icon: Code,
    component: JwtDecoderTool
  },
  {
    id: 'morse-code',
    name: 'Morse Code',
    description: 'Encode text to Morse code or decode Morse code back to text',
    category: 'Encode/Decode',
    icon: Radio,
    component: MorseCodeTool
  },
  {
    id: 'substitution-cipher',
    name: 'Substitution Cipher',
    description: 'Derive, edit, and apply a monoalphabetic substitution cipher key, with frequency analysis',
    category: 'Encode/Decode',
    icon: KeyRound,
    component: SubstitutionCipherTool
  },
  {
    id: 'url-encoder',
    name: 'URL',
    description: 'Encode and decode URL strings',
    category: 'Encode/Decode',
    icon: Link,
    component: UrlEncoderTool
  },
  {
    id: 'xor-cipher',
    name: 'XOR Cipher',
    description: 'Encode or decode text with a repeating-key XOR cipher',
    category: 'Encode/Decode',
    icon: Blend,
    component: XorCipherTool
  },

  // ===== FORMAT CATEGORY =====
  {
    id: 'css-formatter',
    name: 'CSS Formatter',
    description: 'Format and beautify CSS code',
    category: 'Format',
    icon: Code,
    component: CssFormatterTool
  },
  {
    id: 'html-formatter',
    name: 'HTML Formatter',
    description: 'Format and beautify HTML code',
    category: 'Format',
    icon: Code,
    component: HtmlFormatterTool
  },
  {
    id: 'json-formatter',
    name: 'JSON Formatter',
    description: 'Format and validate JSON',
    category: 'Format',
    icon: FileText,
    component: JsonFormatterTool
  },
  {
    id: 'sql-formatter',
    name: 'SQL Formatter',
    description: 'Format and beautify SQL queries',
    category: 'Format',
    icon: Code,
    component: SqlFormatterTool
  },

  // ===== GENERATE CATEGORY =====
  {
    id: 'barcode-generator',
    name: 'Barcode Generator',
    description: 'Generate barcodes from text',
    category: 'Generate',
    icon: Hash,
    component: BarcodeTool
  },
  {
    id: 'csr-generator',
    name: 'CSR Generator',
    description: 'Generate Certificate Signing Requests',
    category: 'Generate',
    icon: Code,
    component: CsrGeneratorTool
  },
  {
    id: 'json-to-interface',
    name: 'JSON to Interface',
    description: 'Generate interfaces from JSON in multiple languages',
    category: 'Generate',
    icon: Code,
    component: JsonToInterfaceTool
  },
  {
    id: 'lorem-ipsum',
    name: 'Lorem Ipsum Generator',
    description: 'Generate placeholder text',
    category: 'Generate',
    icon: FileText,
    component: LoremIpsumTool
  },
  {
    id: 'qr-code-generator',
    name: 'QR Code Generator',
    description: 'Generate QR codes from text',
    category: 'Generate',
    icon: Hash,
    component: QrCodeTool
  },
  {
    id: 'uuid-generator',
    name: 'UUID Generator',
    description: 'Generate UUIDs (v4)',
    category: 'Generate',
    icon: Hash,
    component: UuidGeneratorTool
  },

  // ===== MISCELLANEOUS CATEGORY =====
  {
    id: 'countdown-timer',
    name: 'Countdown Timer',
    description: 'Set countdown timers',
    category: 'Miscellaneous',
    icon: Clock,
    component: CountdownTimerTool
  },
  {
    id: 'cron-parser',
    name: 'Cron Parser',
    description: 'Parse and explain cron expressions',
    category: 'Miscellaneous',
    icon: Clock,
    component: CronExpressionParserTool
  },
  {
    id: 'sentence-builder',
    name: 'Sentence Builder',
    description: 'Manually reconstruct a scrambled sentence from its word bank',
    category: 'Miscellaneous',
    icon: Puzzle,
    component: SentenceBuilderTool
  },
  {
    id: 'histogram',
    name: 'Histogram',
    description: 'Visualize character frequency as a histogram, with full emoji and CJK support',
    category: 'Miscellaneous',
    icon: BarChart2,
    component: HistogramTool
  },
  {
    id: 'markdown-preview',
    name: 'Markdown Preview',
    description: 'Live preview markdown rendering',
    category: 'Miscellaneous',
    icon: Eye,
    component: MarkdownPreviewTool
  },
  {
    id: 'stopwatch',
    name: 'Stopwatch',
    description: 'Simple stopwatch timer',
    category: 'Miscellaneous',
    icon: Clock,
    component: StopwatchTool
  },
  {
    id: 'string-analyzer',
    name: 'String Analyzer',
    description: 'Analyze text statistics and character counts',
    category: 'Miscellaneous',
    icon: Type,
    component: StringAnalyzerTool
  },
  {
    id: 'text-diff',
    name: 'Text Diff',
    description: 'Compare two texts side by side',
    category: 'Miscellaneous',
    icon: Code,
    component: TextDiffTool
  },
  {
    id: 'url-exploder',
    name: 'URL Exploder',
    description: 'Parse and modify URL components',
    category: 'Miscellaneous',
    icon: Link,
    component: UrlExploderTool
  },

  // ===== NETWORKING CATEGORY =====
  {
    id: 'ipv4-subnet-calculator',
    name: 'IPv4 Subnet Calculator',
    description: 'Calculate IPv4 subnet information',
    category: 'Networking',
    icon: Network,
    component: Ipv4SubnetCalculatorTool
  },
  {
    id: 'ipv6-subnet-calculator',
    name: 'IPv6 Subnet Calculator',
    description: 'Calculate IPv6 subnet information',
    category: 'Networking',
    icon: Network,
    component: Ipv6SubnetCalculatorTool
  },
  {
    id: 'whois-lookup',
    name: 'WHOIS Lookup',
    description: 'Look up domain WHOIS information',
    category: 'Networking',
    icon: Globe,
    component: WhoisLookupTool
  },

  // ===== VALIDATE CATEGORY =====
  {
    id: 'iban-validator',
    name: 'IBAN Validator',
    description: 'Validate International Bank Account Numbers',
    category: 'Validate',
    icon: CheckSquare,
    component: IbanValidatorTool
  },
  {
    id: 'regex-validator',
    name: 'Regex Validator',
    description: 'Test regular expressions',
    category: 'Validate',
    icon: Code,
    component: RegexValidatorTool
  },

  // ===== OPENSHIFT CATEGORY =====
  {
    id: 'openshift-templates',
    name: 'Templates',
    description: 'Generate YAML templates for OpenShift/Kubernetes resources',
    category: 'OpenShift',
    icon: Code,
    component: OpenShiftTemplateTool
  },

  // ===== SECURITY CATEGORY =====
  {
    id: 'gtfobins',
    name: 'GTFOBins',
    description: 'Unix binaries that can bypass local security restrictions',
    category: 'Security',
    icon: Shield,
    component: GtfobinsTool
  }
];

// Category definitions
const CATEGORIES = [
  'Calculate',
  'Conversion',
  'Encode/Decode',
  'Format',
  'Generate',
  'Miscellaneous',
  'Networking',
  'OpenShift',
  'Security',
  'Validate'
];

/**
 * Get all tools
 * @returns {Promise<Array>} Array of tool objects
 */
export async function getTools() {
  return TOOLS;
}

/**
 * Get a single tool by ID
 * @param {string} toolId - Tool ID
 * @returns {Promise<Object|null>} Tool object or null
 */
export async function getTool(toolId) {
  return TOOLS.find(tool => tool.id === toolId) || null;
}

/**
 * Get all tool categories
 * @returns {Promise<Array>} Array of category names
 */
export async function getToolCategories() {
  return CATEGORIES;
}

/**
 * Get tools by category
 * @param {string} category - Category name
 * @returns {Promise<Array>} Array of tool objects
 */
export async function getToolsByCategory(category) {
  return TOOLS.filter(tool => tool.category === category);
}
