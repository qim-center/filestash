import React from "react";
import { Select } from "../../components";


export class ChownComponent extends React.Component {


    render() {
        if (!this.props.fileInfo){
            return <div></div>;
        }

        let isOwner = this.props.fileInfo.uid === this.props.userInfo.uid;
        let index = this.props.userInfo.gids.indexOf(this.props.fileInfo.gid);
        let group = (index >= 0) ? this.props.userInfo.gnames[index] : this.props.fileInfo.gid;

        return (
        <div>
            <p>Owner: {isOwner ? "You": this.props.fileInfo.uid}</p>
            <p>Group: {group}</p>
        </div>
        );

    };
}