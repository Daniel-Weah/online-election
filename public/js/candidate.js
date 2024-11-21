
        document.getElementById('photo').addEventListener('change', function(event) {
            const preview = document.getElementById('photoPreview');
            const file = event.target.files[0];
    
            if (file) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    preview.src = e.target.result;
                    preview.style.display = 'block';
                };
                reader.readAsDataURL(file);
            } else {
                preview.src = '';
                preview.style.display = 'none';
            }
        });
    


document.getElementById('candidateRegistrationForm').addEventListener('submit', (e) => {
    e.preventDefault();
    console.log("Form submission triggered");

    const formData = new FormData(e.target);
    console.log("Form data prepared");

    fetch('/candidate/registration', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then((data) => {
       if(data.success){
            Swal.fire({
                title: 'Candidate Successfully Registered!',
                text: data.message,
                icon: 'success',
                showConfirmButton: false,
                timer: 3000
            }).then(() => {
                document.getElementById('candidateRegistrationForm').reset();
            });
        } else {
            Swal.fire({
                title: 'Error',
                text: data.message,
                icon: 'error',
                showConfirmButton: false,
                timer: 3000
            });
        }
    })
    .catch(error => {
        Swal.fire({
            title: 'Error',
            text: 'There was a problem sending your information. Please try again later.',
            icon: 'error',
            showConfirmButton: false,
            timer: 3000
        });
        console.error('Error:', error);
    });
});
