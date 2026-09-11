const Footer = () => {
  return (
    <footer className="bg-gray-800 text-white text-center p-4 mt-auto">
      <div className="container mx-auto">
        <p>&copy; {new Date().getFullYear()} DOE. All rights reserved.</p>
      </div>
    </footer>
  );
};

export default Footer;