document.getElementById("voteForm").addEventListener("submit", (e) => {
  e.preventDefault();
  console.log('Vote form submitting');
  
  const formData = new FormData(e.target);
  
  fetch("/vote", {
    method: "POST",
    body: formData, // Send as FormData, not JSON
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.success) {
        Swal.fire({
          title: "Your Vote Counted",
          text: data.message,
          icon: "success",
          showConfirmButton: false,
          timer: 2000,
        }).then(() => {
          window.location.href = "/dashboard"; 
        });
      } else {
        Swal.fire({
          title: 'Error',
          text: data.message,
          icon: 'error',
          showConfirmButton: false,
          timer: 2000,
        });
      }
    })
    .catch((error) => {
      Swal.fire({
        title: 'Error',
        text: 'There was an error making your vote count. Please try again later.',
        icon: 'error',
        showConfirmButton: false,
        timer: 2000,
      });
      console.error('Error:', error);
    });
});
