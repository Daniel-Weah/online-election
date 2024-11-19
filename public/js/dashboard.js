

function loadContent(page) {
    const contentArea = document.getElementById('content-area');
    
    fetch(page)
      .then(response => response.text())
      .then(data => {
        contentArea.innerHTML = data;
      })
      .catch(error => console.error('Error loading content:', error));
  }
  