  document.getElementById("elections-dropdown").addEventListener("change", function () {
    const selectedElectionId = this.value;
    window.location.href = `/dashboard?electionId=${selectedElectionId}`;
  });
