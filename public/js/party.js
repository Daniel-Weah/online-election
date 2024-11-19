document.getElementById('partyLogo').addEventListener('change', (e) => {
    const preview = document.getElementById('photoPreview');

    const file = e.target.files[0];

    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            preview.src = e.target.result;
            preview.style.display = 'block';
        };
        reader.readAsDataURL(file);
    } else {
        preview.src = '';
        preview.style.display = 'none';
    }
});


document.getElementById('partyRegistrationForm').addEventListener('submit', (e) => {
    e.preventDefault();

    const partyData = new FormData(e.target);
    
    fetch('/create/party', {
        method: 'POST',
        body: partyData
    })
    .then(response => {
        console.log('Response status:', response.status);
        if (response.ok) {
            Swal.fire({
                title: 'Party Successfully Created!',
                text: 'Your party has been registered.',
                icon: 'success',
                showConfirmButton: false,
                timer: 2000
            }).then(() => {
                document.getElementById('partyRegistrationForm').reset();
            });
        } else {
            Swal.fire({
                title: 'Error',
                text: 'There was a problem sending your information. Please try again later.',
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
        console.log('Error', error);
    });
});