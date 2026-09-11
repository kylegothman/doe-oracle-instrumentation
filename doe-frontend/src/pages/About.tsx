import React from 'react';
import { motion } from 'framer-motion';

const About: React.FC = () => {
  return (
    <motion.div 
      className="space-y-8 lg:space-y-12"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="text-center">
        <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-pink-400 to-purple-400">
          About DOE
        </h1>
        <p className="mt-4 text-base md:text-lg lg:text-xl text-white/80 max-w-5xl mx-auto">
          Pioneering the future of combinatorial testing and software quality assurance.
        </p>
      </div>

      <motion.div 
        className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-12 items-center"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-white">Our Mission</h2>
          <p className="text-white/80 leading-relaxed">
            DOE is dedicated to advancing the field of combinatorial testing through innovative research and practical applications. Our mission is to develop cutting-edge methodologies that improve software quality and testing efficiency.
          </p>
          <div className="space-y-4">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Innovation</h3>
                <p className="text-white/70">Pushing the boundaries of combinatorial testing research</p>
              </div>
            </div>
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-purple-500/20 to-indigo-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Quality</h3>
                <p className="text-white/70">Ensuring the highest standards in software testing</p>
              </div>
            </div>
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Community</h3>
                <p className="text-white/70">Building a global network of testing professionals</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white/10 backdrop-blur-lg rounded-xl p-8 border border-white/20">
          <h2 className="text-2xl font-bold text-white mb-6">Our Team</h2>
          <div className="space-y-6">
            <div className="flex items-center space-x-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <span className="text-xl font-bold text-white">EW</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Eric Wong</h3>
                <p className="text-white/70">Principal Investigator</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <span className="text-xl font-bold text-white">TH</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Thomas Hill</h3>
                <p className="text-white/70">Project Mentor</p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-pink-500/20 to-purple-500/20 flex items-center justify-center">
                <span className="text-xl font-bold text-white">ZC</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Zizhao Chen</h3>
                <p className="text-white/70">Human Expert</p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500/20 to-indigo-500/20 flex items-center justify-center">
                <span className="text-xl font-bold text-white">DT</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Development Team Spring 2025</h3> 
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <p className="text-white/70">Logan Margabandu</p>
                  <p className="text-white/70">Abdulrahman Zanawar</p>
                  <p className="text-white/70">Johnathan Vu</p>
                  <p className="text-white/70">Deryck Overturff</p>
                  <p className="text-white/70">Sheerinah Murad</p>
                  <p className="text-white/70">Muhammad Fahin</p>
                </div> {/*//Added team member names as contributors for the Fall 2025 semester*/}
                <h3 className="text-lg font-semibold text-white mt-6 mb-2">Development Team Fall 2025</h3>
                <div className="grid grid-cols-2 gap-2">
                  <p className="text-white/70">Shreyaa Arun</p>
                  <p className="text-white/70">Erika Barron</p>
                  <p className="text-white/70">Mariam Hamza</p>
                  <p className="text-white/70">Josetta A. Reyes</p>
                  <p className="text-white/70">Eslam M. Shamait</p>
                  <p className="text-white/70">Jasmine K. Torres</p> 
                </div>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center">
                <span className="text-xl font-bold text-white">DS</span>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white">Research Staff</h3>
                <p className="text-white/70">Testing Specialists</p>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

    </motion.div>
  );
};

export default About;
