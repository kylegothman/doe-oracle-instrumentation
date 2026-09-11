import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import doeLogo from '/images/doe-logo-final.png';

const Navbar = () => {
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <motion.nav 
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className="bg-gradient-to-r from-gray-900 via-black to-gray-900 border-b border-violet-900/30 shadow-lg sticky top-0 z-50 backdrop-blur-sm bg-opacity-80"
    >
      <div className="container mx-auto flex justify-between items-center py-2">
          <Link to="/" className="flex items-center space-x-3">
            <img src={doeLogo} alt="DOE Logo" className="h-12 w-12 md:h-14 md:w-14" />
            <span className="text-2xl font-bold">
              DOE
            </span>
          </Link>
          <nav className="hidden md:flex space-x-1 items-center">
            <NavLink to="/" currentPath={location.pathname}>Home</NavLink>
            <NavLink to="/about" currentPath={location.pathname}>About</NavLink>
            <NavLink to="/research" currentPath={location.pathname}>Research</NavLink>
            <NavLink to="/chat" currentPath={location.pathname}>Chat</NavLink>
            <NavLink to="/contact" currentPath={location.pathname}>Contact</NavLink>
          </nav>
          <button 
            className="md:hidden p-2"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
        
        {/* Mobile Menu */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="md:hidden border-t border-violet-900/30 bg-gray-900/95 backdrop-blur-sm"
            >
              <div className="container mx-auto px-4 py-4 space-y-2">
                <MobileNavLink to="/" currentPath={location.pathname} onClick={() => setIsMobileMenuOpen(false)}>
                  Home
                </MobileNavLink>
                <MobileNavLink to="/about" currentPath={location.pathname} onClick={() => setIsMobileMenuOpen(false)}>
                  About
                </MobileNavLink>
                <MobileNavLink to="/research" currentPath={location.pathname} onClick={() => setIsMobileMenuOpen(false)}>
                  Research
                </MobileNavLink>
                <MobileNavLink to="/chat" currentPath={location.pathname} onClick={() => setIsMobileMenuOpen(false)}>
                  Chat
                </MobileNavLink>
                <MobileNavLink to="/contact" currentPath={location.pathname} onClick={() => setIsMobileMenuOpen(false)}>
                  Contact
                </MobileNavLink>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
    </motion.nav>
  );
};

const NavLink = ({ to, children, currentPath }: { to: string; children: React.ReactNode; currentPath: string }) => (
  <Link to={to}>
    <motion.div
      whileHover={{ scale: 1.05 }}
      className={`px-4 py-2 rounded-lg transition-all duration-300 ${
        currentPath === to
          ? 'bg-gradient-to-r from-violet-900 to-indigo-800 text-white shadow-lg shadow-violet-900/50'
          : 'text-gray-300 hover:bg-violet-900/30 hover:text-white'
      }`}
    >
      {children}
    </motion.div>
  </Link>
);

const MobileNavLink = ({ to, children, currentPath, onClick }: { 
  to: string; 
  children: React.ReactNode; 
  currentPath: string; 
  onClick: () => void;
}) => (
  <Link to={to} onClick={onClick}>
    <div
      className={`block px-4 py-3 rounded-lg transition-all duration-300 ${
        currentPath === to
          ? 'bg-gradient-to-r from-violet-900 to-indigo-800 text-white shadow-lg shadow-violet-900/50'
          : 'text-gray-300 hover:bg-violet-900/30 hover:text-white'
      }`}
    >
      {children}
    </div>
  </Link>
);

export default Navbar;