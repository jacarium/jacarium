import { useState, useRef, useEffect } from 'react';
import { Copy, Check, FileJson } from 'lucide-react';

export default function XmlToJsonTool() {
  const [xmlInput, setXmlInput] = useState('');
  const [jsonOutput, setJsonOutput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  const [format, setFormat] = useState('compact'); // 'compact' or 'verbose'
  const [showSamples, setShowSamples] = useState(false);
  const samplesRef = useRef(null);

  // Close samples dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (samplesRef.current && !samplesRef.current.contains(event.target)) {
        setShowSamples(false);
      }
    };

    if (showSamples) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSamples]);

  // Convert XML to JSON in compact format
  const xmlToJsonCompact = (xml) => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xml, 'text/xml');

    // Check for parse errors
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid XML structure');
    }

    const obj = {};

    const parseNode = (node) => {
      const nodeObj = {};

      // Handle attributes
      if (node.attributes && node.attributes.length > 0) {
        nodeObj['@attributes'] = {};
        for (let i = 0; i < node.attributes.length; i++) {
          const attr = node.attributes[i];
          nodeObj['@attributes'][attr.name] = attr.value;
        }
      }

      // Handle child nodes
      if (node.hasChildNodes()) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];

          if (child.nodeType === 3) { // Text node
            const text = child.nodeValue.trim();
            if (text) {
              if (Object.keys(nodeObj).length === 0) {
                return text;
              }
              nodeObj['#text'] = text;
            }
          } else if (child.nodeType === 1) { // Element node
            const childName = child.nodeName;
            const childValue = parseNode(child);

            if (nodeObj[childName]) {
              // Multiple children with same name - convert to array
              if (!Array.isArray(nodeObj[childName])) {
                nodeObj[childName] = [nodeObj[childName]];
              }
              nodeObj[childName].push(childValue);
            } else {
              nodeObj[childName] = childValue;
            }
          }
        }
      }

      return Object.keys(nodeObj).length === 0 ? '' : nodeObj;
    };

    if (xmlDoc.documentElement) {
      obj[xmlDoc.documentElement.nodeName] = parseNode(xmlDoc.documentElement);
    }

    return obj;
  };

  // Convert XML to JSON in verbose format (with metadata)
  const xmlToJsonVerbose = (xml) => {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xml, 'text/xml');

    // Check for parse errors
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid XML structure');
    }

    const parseNode = (node) => {
      const element = {
        type: 'element',
        name: node.nodeName
      };

      // Handle attributes
      if (node.attributes && node.attributes.length > 0) {
        element.attributes = {};
        for (let i = 0; i < node.attributes.length; i++) {
          const attr = node.attributes[i];
          element.attributes[attr.name] = attr.value;
        }
      }

      // Handle child nodes
      const elements = [];

      if (node.hasChildNodes()) {
        for (let i = 0; i < node.childNodes.length; i++) {
          const child = node.childNodes[i];

          if (child.nodeType === 3) { // Text node
            const text = child.nodeValue.trim();
            if (text) {
              element.text = text;
            }
          } else if (child.nodeType === 1) { // Element node
            elements.push(parseNode(child));
          }
        }
      }

      if (elements.length > 0) {
        element.elements = elements;
      }

      return element;
    };

    if (xmlDoc.documentElement) {
      const rootName = xmlDoc.documentElement.nodeName;
      return {
        [rootName]: [parseNode(xmlDoc.documentElement)]
      };
    }

    return {};
  };

  const handleConvert = (value, currentFormat) => {
    const selectedFormat = currentFormat !== undefined ? currentFormat : format;

    if (!value || !value.trim()) {
      setJsonOutput('');
      setError('');
      return;
    }

    try {
      const result = selectedFormat === 'verbose'
        ? xmlToJsonVerbose(value)
        : xmlToJsonCompact(value);
      setJsonOutput(JSON.stringify(result, null, 2));
      setError('');
    } catch (err) {
      setError('Invalid XML: ' + err.message);
      setJsonOutput('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonOutput);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const samples = [
    {
      name: 'Book Catalog',
      xml: `<?xml version="1.0"?>
<catalog>
  <book id="bk101">
    <author>Gambardella, Matthew</author>
    <title>XML Developer's Guide</title>
    <price>44.95</price>
  </book>
  <book id="bk102">
    <author>Ralls, Kim</author>
    <title>Midnight Rain</title>
    <price>5.95</price>
  </book>
</catalog>`
    },
    {
      name: 'User Profile',
      xml: `<?xml version="1.0"?>
<user>
  <name>John Doe</name>
  <email>john@example.com</email>
  <age>30</age>
  <address>
    <street>123 Main St</street>
    <city>New York</city>
    <zip>10001</zip>
  </address>
</user>`
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <FileJson size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            XML to JSON
          </h3>
        </div>

        {/* Format Toggle */}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="compact"
              checked={format === 'compact'}
              onChange={(e) => { setFormat(e.target.value); handleConvert(xmlInput, e.target.value); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Compact</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              value="verbose"
              checked={format === 'verbose'}
              onChange={(e) => { setFormat(e.target.value); handleConvert(xmlInput, e.target.value); }}
              className="text-os-blue focus:ring-os-blue"
            />
            <span className="text-sm text-os-text-primary">Verbose (with metadata)</span>
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">XML Input</label>
            <div className="relative" ref={samplesRef}>
              <button
                onClick={() => setShowSamples(!showSamples)}
                className="flex items-center gap-1 px-3 py-1 text-xs text-os-text-secondary hover:text-os-text-primary bg-os-card border border-os-border rounded-sm hover:bg-os-card-secondary transition-colors"
              >
                Samples
              </button>
              {showSamples && (
                <div className="absolute right-0 top-full mt-1 w-80 bg-os-card border border-os-border rounded-sm shadow-lg z-10 max-h-96 overflow-auto">
                  <div className="p-1">
                    {samples.map((sample, index) => (
                      <button
                        key={index}
                        onClick={() => {
                          setXmlInput(sample.xml);
                          handleConvert(sample.xml, format);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.xml.split('\n')[1]}</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea value={xmlInput} onChange={(e) => { setXmlInput(e.target.value); handleConvert(e.target.value, format); }} placeholder="<root><item>value</item></root>" className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue placeholder:text-os-text-muted" />
        </div>
        {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm text-os-text-primary">JSON Output</label>
            {jsonOutput && <button onClick={handleCopy} className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors">{copied === 'output' ? <><Check size={12} />Copied!</> : <>Copy</>}</button>}
          </div>
          {jsonOutput ? (
            <textarea value={jsonOutput} readOnly className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none" />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              JSON output will appear here after entering XML
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
