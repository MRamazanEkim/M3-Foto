// config.example.js
// Bu dosyayı config.js olarak kopyalayın ve Render URL'nizi ekleyin

module.exports = {
  // Render'da deploy ettiğiniz sunucunun URL'i
  // Örnek: https://m3-foto-server.onrender.com
  SERVER_URL: process.env.RENDER_URL || process.env.SERVER_URL || 'http://localhost:3000'
};
