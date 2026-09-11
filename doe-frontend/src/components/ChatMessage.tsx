import React from 'react';
import { motion } from 'framer-motion';

interface Evidence {
  quote: string;
  source: string;
  page: string;
  supports: string;
}

interface ChatMessageProps {
  message: string;
  evidence?: Evidence[];
  isUser: boolean;
}

//<SpeakerWaveIcon className="h-8 w-8" />

const ChatMessage: React.FC<ChatMessageProps> = ({ message, evidence, isUser }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
    >
      <div className={`relative max-w-[80%] ${isUser ? 'order-1' : 'order-2'}`}>
        <div
          className={`rounded-lg px-4 py-2 ${
            isUser
              ? 'bg-gradient-to-r from-violet-600 to-indigo-800 text-white'
              : 'bg-gray-800 text-gray-200'
          }`}
        >
          <p className="text-base">{message}</p>
          {evidence && evidence.length > 0 && (
            <div className="mt-3 border-t border-gray-600 pt-3">
              <h4 className="text-sm font-semibold mb-2 text-blue-300">📚 Source Evidence:</h4>
              <div className="space-y-2">
                {evidence.map((item, index) => (
                  <div key={index} className="bg-gray-700 rounded p-2 text-xs">
                    <div className="italic text-gray-300 mb-1">
                      "{item.quote}"
                    </div>
                    <div className="text-blue-400 font-medium">
                      📄 {item.source} • Page {item.page}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default ChatMessage;