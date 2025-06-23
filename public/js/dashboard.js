document.addEventListener("DOMContentLoaded", function () {
  const dropdown = document.getElementById("elections-dropdown");
  if (dropdown) {
    dropdown.addEventListener("change", function () {
      const selectedElectionId = this.value;
      window.location.href = `/dashboard?electionId=${selectedElectionId}`;
    });
  }
});
