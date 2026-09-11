const ContactUs = () => (
  <div className="space-y-6 max-w-2xl mx-auto px-4">
    <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500 bg-clip-text text-transparent text-center">Contact Us</h1>
    <p className="text-gray-300 mb-6">
      Have questions about our testing solutions or need technical support? We'd love to hear from you!
    </p>
    <form className="space-y-4">
      <div>
        <label htmlFor="name" className="block text-sm font-medium text-gray-400 mb-1">Name</label>
        <input type="text" id="name" name="name" required
               className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent" />
      </div>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-gray-400 mb-1">Email</label>
        <input type="email" id="email" name="email" required
               className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent" />
      </div>
      <div>
        <label htmlFor="message" className="block text-sm font-medium text-gray-400 mb-1">Message</label>
        <textarea id="message" name="message" rows={4} required
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"></textarea>
      </div>
      <button type="submit"
              className="w-full bg-gradient-to-r from-violet-600 to-indigo-800 hover:from-violet-700 hover:to-indigo-900 text-white font-bold py-2 px-4 rounded-md shadow-lg transform hover:scale-105 transition duration-300">
        Send Message
      </button>
    </form>
  </div>
);

export default ContactUs; 