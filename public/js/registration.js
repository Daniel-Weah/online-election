document.getElementById('registrationForm').addEventListener('submit', (e) => {
    e.preventDefault();
    
    const formData = new FormData(e.target);

    fetch('/voters', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json()) // Convert to JSON
    .then(data => {
        if (data.success) {
            Swal.fire({
                title: 'Registration Successful',
                text: data.message,
                icon: 'success',
                showConfirmButton: false,
                timer: 2000
            }).then(() => {
                document.getElementById('registrationForm').reset();
                window.location.reload();
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
            text: 'There was a problem sending your information. Please try again later.',
            icon: 'error',
            showConfirmButton: false,
            timer: 2000
        });
        console.error('Error:', error);
    });
});

// =============    PREVIEW OF THE USER PROFILE PICTURE =============
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

