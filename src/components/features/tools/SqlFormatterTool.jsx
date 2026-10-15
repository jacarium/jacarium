import { useState, useRef, useEffect } from 'react';
import { Code } from 'lucide-react';

export default function SqlFormatterTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
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

  const formatSql = (sql) => {
    if (!sql || !sql.trim()) {
      return '';
    }

    try {

      let formatted = sql;

      // Normalize whitespace
      formatted = formatted.replace(/\s+/g, ' ').trim();

      // Add newlines before major keywords
      const majorKeywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY',
                             'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'INSERT INTO',
                             'VALUES', 'UPDATE', 'SET', 'DELETE'];

      majorKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        formatted = formatted.replace(regex, `\n${keyword.toUpperCase()}`);
      });

      // Handle JOIN keywords with proper formatting
      const joinKeywords = ['LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN',
                           'FULL JOIN', 'CROSS JOIN', 'JOIN'];
      joinKeywords.forEach(keyword => {
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
        formatted = formatted.replace(regex, `\n${keyword.toUpperCase()}`);
      });

      // Handle ON and AND/OR for JOIN conditions
      formatted = formatted.replace(/\bON\b/gi, '\n  ON');

      // Add spaces around operators
      formatted = formatted.replace(/=/g, ' = ');
      formatted = formatted.replace(/</g, ' < ');
      formatted = formatted.replace(/>/g, ' > ');
      formatted = formatted.replace(/!=/g, ' != ');
      formatted = formatted.replace(/<>/g, ' <> ');
      formatted = formatted.replace(/\s+/g, ' '); // Clean up multiple spaces

      // Format commas - put them at the end of line and next item indented
      formatted = formatted.replace(/,\s*/g, ',\n  ');

      // Indent content after SELECT, SET
      formatted = formatted.replace(/SELECT\s+/gi, 'SELECT\n  ');
      formatted = formatted.replace(/SET\s+/gi, 'SET\n  ');

      // Clean up extra newlines
      formatted = formatted.replace(/\n\s*\n/g, '\n');

      // Trim each line
      formatted = formatted.split('\n').map(line => line.trim()).join('\n');

      // Final trim
      formatted = formatted.trim();

      return formatted;
    } catch (err) {
      throw new Error('Failed to format SQL: ' + err.message);
    }
  };

  const handleFormat = (value) => {
    if (!value || !value.trim()) {
      setOutput('');
      setError('');
      return;
    }

    try {
      const formatted = formatSql(value);
      setOutput(formatted);
      setError('');
    } catch (err) {
      setError(err.message);
      setOutput('');
    }
  };

  const samples = [
    {
      name: 'Simple SELECT',
      sql: 'SELECT id, name, email FROM users WHERE active = 1 ORDER BY name'
    },
    {
      name: 'JOIN Query',
      sql: 'SELECT u.id, u.name, o.order_id, o.total FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.status = \'completed\''
    },
    {
      name: 'Multiple JOINs',
      sql: 'SELECT c.name, o.order_date, p.product_name, od.quantity FROM customers c LEFT JOIN orders o ON c.id = o.customer_id LEFT JOIN order_details od ON o.id = od.order_id LEFT JOIN products p ON od.product_id = p.id'
    },
    {
      name: 'GROUP BY with Aggregate',
      sql: 'SELECT department, COUNT(*) as employee_count, AVG(salary) as avg_salary FROM employees GROUP BY department HAVING COUNT(*) > 5 ORDER BY avg_salary DESC'
    },
    {
      name: 'INSERT',
      sql: 'INSERT INTO users (name, email, created_at) VALUES (\'John Doe\', \'john@example.com\', NOW())'
    },
    {
      name: 'UPDATE',
      sql: 'UPDATE users SET status = \'active\', updated_at = NOW() WHERE id = 123'
    },
    {
      name: 'Subquery',
      sql: 'SELECT name, salary FROM employees WHERE salary > (SELECT AVG(salary) FROM employees)'
    },
    {
      name: 'UNION',
      sql: 'SELECT customer_id, name FROM customers WHERE region = \'North\' UNION SELECT customer_id, name FROM customers WHERE region = \'South\''
    },
  ];

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            SQL Formatter
          </h3>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-os-text-primary">SQL Input</label>
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
                          setInput(sample.sql);
                          handleFormat(sample.sql);
                          setShowSamples(false);
                        }}
                        className="w-full px-3 py-2 text-sm rounded-sm hover:bg-os-border transition-colors text-left"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-os-text-primary">{sample.name}</span>
                          <code className="text-xs text-os-text-muted font-mono truncate">{sample.sql.substring(0, 50)}...</code>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <textarea value={input} onChange={(e) => { setInput(e.target.value); handleFormat(e.target.value); }} placeholder="SELECT * FROM users WHERE id=1" className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue placeholder:text-os-text-muted" />
        </div>
        {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">{error}</div>}
        <div>
          <label className="block text-sm text-os-text-primary mb-2">Formatted SQL</label>
          {output ? (
            <textarea value={output} readOnly className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm resize-none" />
          ) : (
            <div className="w-full h-64 px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary">
              Formatted SQL will appear here after entering SQL
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
