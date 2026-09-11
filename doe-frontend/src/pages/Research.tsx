import { motion } from 'framer-motion';

const Research = () => (
  <div className="max-w-6xl mx-auto px-2 py-4">
    <motion.h1 
      className="text-3xl md:text-4xl lg:text-5xl font-bold mb-6 lg:mb-8 bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500 bg-clip-text text-transparent"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      Research Areas
    </motion.h1>

    <motion.div 
      className="space-y-6 lg:space-y-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <div className="bg-gray-800 rounded-xl p-6 shadow-lg border border-violet-900/30">
        <h2 className="text-2xl font-semibold text-violet-400 mb-4">Overview</h2>
        <p className="text-gray-300 mb-6">
          Explore the latest research in combinatorial testing, software quality assurance, and AI-driven testing methodologies. 
          Our platform integrates cutting-edge academic findings with practical applications.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-6 shadow-lg border border-violet-900/30">
        <h2 className="text-2xl font-semibold text-violet-400 mb-4">Core Publications</h2>
        <div className="space-y-6">
          <div className="border-l-2 border-violet-500 pl-4">
            <h3 className="text-xl text-gray-200 font-medium">Applying Combinatorial Testing in Industrial Settings</h3>
            <p className="text-gray-400 mt-2">
              This paper explores the practical implementation of combinatorial testing in real-world industrial environments,
              providing insights into its effectiveness and challenges.
            </p>
          </div>

          <div className="border-l-2 border-violet-500 pl-4">
            <h3 className="text-xl text-gray-200 font-medium">How Does Combinatorial Testing Perform in the Real World?</h3>
            <p className="text-gray-400 mt-2">
              An empirical study examining the performance and effectiveness of combinatorial testing approaches
              when applied to real-world software systems.
            </p>
          </div>

          <div className="border-l-2 border-violet-500 pl-4">
            <h3 className="text-xl text-gray-200 font-medium">Improving MC/DC and Fault Detection Strength Using Combinatorial Testing</h3>
            <p className="text-gray-400 mt-2">
              This research investigates how combinatorial testing can enhance Modified Condition/Decision Coverage (MC/DC)
              and improve fault detection capabilities in software testing.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded-xl p-6 shadow-lg border border-violet-900/30">
        <h2 className="text-2xl font-semibold text-violet-400 mb-4">Research Impact</h2>
        <p className="text-gray-300">
          These publications form the foundation of our AI-powered research assistant, enabling it to provide
          accurate and evidence-based responses about combinatorial testing and software quality assurance.
          The research findings have been integrated into our system to offer practical insights and guidance
          based on real-world applications and empirical studies.
        </p>
      </div>
    </motion.div>
  </div>
);

export default Research; 