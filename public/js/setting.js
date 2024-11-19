
document.getElementById('updateUsernameForm').addEventListener('submit', (e) => {
    e.preventDefault();
   
    const formData = new FormData(e.target);
    const formObject = Object.fromEntries(formData.entries());
   
    fetch('/setting/change/username', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(formObject)
    })
    .then(response => response.json())
    .then((data) => {
        console.log(data);
        if (data.success) {
            Swal.fire({
                title: 'Username updated Successfully',
                text: data.message,
                icon: 'success',
                showConfirmButton: false,
                timer: 2000
            }).then(() => {
                document.getElementById('updateUsernameForm').reset();
            });
        } else {
            Swal.fire({
                title: 'Error',
                text: data.message,
                icon: 'error',
                showConfirmButton: false,
                timer: 2000
            });
        }
    })
    .catch(error => {
        Swal.fire({
            title: 'Error',
            text: 'There was a problem updating your information. Please try again later.',
            icon: 'error',
            showConfirmButton: false,
            timer: 2000
        });
        console.error('Error:', error);
    });
   });
   
   
   document.getElementById('forgetPasswordForm').addEventListener('submit', (e) => {
    e.preventDefault();
   
    const formData = new FormData(e.target);
    const formObject = Object.fromEntries(formData.entries());
   
    fetch('/setting/forget-password', {
      method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(formObject)
    })
    .then(response => response.json())
    .then((data) => {
     if (data.success) {
      Swal.fire({
       title: 'Password updated Successfully',
       text: data.message,
       icon: 'success',
       showConfirmButton: false,
       timer: 2000
   }).then(() => {
       document.getElementById('forgetPasswordForm').reset();
   });
     } else {
      Swal.fire({
          title: 'Error',
          text: data.message,
          icon: 'error',
          showConfirmButton: false,
          timer: 2000
      });
   }
   })
   .catch(error => {
   Swal.fire({
      title: 'Error',
      text: 'There was a problem updating your information. Please try again later.',
      icon: 'error',
      showConfirmButton: false,
      timer: 2000
   });
   console.error('Error:', error);
   });
    })