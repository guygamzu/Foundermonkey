'use client';

import { useState, useRef, useEffect } from 'react';
import { askDocumentQuestion, type QAResponse } from '@/lib/api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{ section: string; text: string }>;
}

interface ChatWidgetProps {
  token: string;
}

export default function ChatWidget({ token }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Hi! I can answer questions about this document. What would you like to know?' },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    setInput('');
    const userMessage: Message = { role: 'user', content: question };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const history = messages
        .filter((m) => m.role !== 'assistant' || messages.indexOf(m) !== 0)
        .map((m) => ({ role: m.role, content: m.content }));

      const response: QAResponse = await askDocumentQuestion(token, question, history);

      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: response.answer,
        citations: response.citations,
      }]);
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: 'Sorry, I had trouble answering that. Please try again.',
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        className="chat-toggle"
        onClick={() => setIsOpen(true)}
        aria-label="Ask about this document"
        title="Ask about this document"
      >
        ?
      </button>
    );
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Ask about this document</span>
        <button className="modal-close" onClick={() => setIsOpen(false)}>&times;</button>
      </div>

      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            <p>{msg.content}</p>
            {msg.citations?.map((c, j) => (
              <p key={j} style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: 4 }}>
                [{c.section}]: &ldquo;{c.text}&rdquo;
              </p>
            ))}
          </div>
        ))}
        {isLoading && (
          <div className="chat-message assistant">
            <p style={{ opacity: 0.6 }}>Thinking...</p>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        <input
          className="chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Ask a question..."
          disabled={isLoading}
        />
        <button
          className="chat-send"
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
          aria-label="Send"
        >
          &uarr;
        </button>
      </div>
    </div>
  );
}
